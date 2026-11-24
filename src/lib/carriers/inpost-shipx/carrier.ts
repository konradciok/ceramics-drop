/**
 * InPost ShipX adapter for the carrier contract (src/lib/carriers/types.ts).
 *
 * ShipX lifecycle: create (or adopt by reference) → for courier, schedule a
 * dispatch order → poll until an offer is buyable → buy it, which produces the
 * label (`confirmed`). Order-level orchestration lives in src/lib/shipment.ts.
 */
import * as Sentry from '@sentry/nextjs';
import { LABEL_READY_STATUS } from '@/lib/carriers/status';
import type { CarrierShipment, ShipmentCarrier } from '@/lib/carriers/types';
import { buildDispatchOrderPayload, buildShipmentPayload, pickBuyableOffer } from './payload';
import type { InPostClient, ShipxShipment } from './client';

/**
 * Poll until a buyable offer appears on the shipment, then buy it.
 *
 * Idempotent: if the shipment is already `confirmed` (LABEL_READY_STATUS) the
 * function returns immediately without calling `buyShipment` — safe to call on
 * every webhook replay.
 *
 * ShipX errors (e.g. offer_expired) are NOT caught here; they propagate so the
 * webhook route's existing `shouldRethrowShipmentError` gate can decide whether
 * to retry or swallow.
 */
export async function buyShipmentWhenReady(
  inpost: InPostClient,
  shipmentId: string,
  opts?: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  // Defaults are tuned for the in-webhook call path: worst-case wall time must stay
  // well under Stripe's ~30 s webhook deadline (each getShipment already carries a
  // 10 s timeout). Offers are normally ready on the creation response, so attempt 0
  // usually succeeds immediately. If not, a later Stripe webhook redelivery retries
  // the buy via the idempotent path — so a short in-webhook poll is sufficient and
  // safer than a long one.
  const maxAttempts = opts?.attempts ?? 2;
  const delayMs = opts?.delayMs ?? 2000;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // First GET — also serves as the first poll iteration.
  let shipment = await inpost.getShipment(shipmentId);

  // Idempotency guard: already confirmed → label already bought, nothing to do.
  if (shipment.status === LABEL_READY_STATUS) return;

  // attempt 0 evaluates the GET above; sleep + re-GET only happen on later attempts.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const offerId = pickBuyableOffer(shipment);
    if (offerId !== null) {
      await inpost.buyShipment(shipmentId, offerId);
      return;
    }
    // No buyable offer yet — wait, then re-GET (unless this was the last attempt).
    if (attempt < maxAttempts - 1) {
      await sleep(delayMs);
      shipment = await inpost.getShipment(shipmentId);
    }
  }

  throw new Error(
    `buyShipmentWhenReady: no buyable offer found for shipment ${shipmentId} after ${maxAttempts} attempt(s)`,
  );
}

/**
 * Pick the oldest (first-created) shipment among multiple reference matches.
 * Multiple matches mean a prior create-then-save-failed cycle repeated more
 * than once; adopting anything but the earliest would orphan it instead.
 * Extras are logged as a warning — cancelling them is out of scope here.
 */
function pickOldestShipment(shipments: ShipxShipment[], orderId: string): ShipxShipment {
  const sorted = [...shipments].sort((a, b) => {
    const at = typeof a.created_at === 'string' ? Date.parse(a.created_at) : NaN;
    const bt = typeof b.created_at === 'string' ? Date.parse(b.created_at) : NaN;
    if (!Number.isNaN(at) && !Number.isNaN(bt)) return at - bt;
    // Fallback when created_at is missing/unparseable: ShipX ids are assigned
    // sequentially, so the lower id was created first.
    return Number(a.id) - Number(b.id);
  });
  if (sorted.length > 1) {
    const orphanIds = sorted.slice(1).map((s) => s.id);
    console.warn(
      `createOrderShipment: multiple ShipX shipments found for order ${orderId} reference — ` +
        `adopting oldest ${sorted[0].id}, leaving orphaned in ShipX: ${orphanIds.join(', ')}`,
    );
    // The orphans need a manual ShipX cancel — a console.warn alone is invisible
    // operationally, so surface it (constant message → one grouped Sentry issue).
    Sentry.captureMessage('shipx_orphaned_shipments', {
      level: 'warning',
      extra: { orderId, adopted: String(sorted[0].id), orphaned: orphanIds.map(String) },
    });
  }
  return sorted[0];
}

function toCarrierShipment(shipment: ShipxShipment): CarrierShipment {
  return {
    id: String(shipment.id),
    trackingNumber: shipment.tracking_number ?? null,
    status: shipment.status,
  };
}

/** The ShipX carrier over an InPost client (`getInPost()` / `inpostFromEnv()`). */
export function shipxCarrier(inpost: InPostClient): ShipmentCarrier {
  return {
    channel: 'inpost_shipx',

    async create(order, { adoptExisting }) {
      // Build first: an order that cannot produce a valid payload must fail
      // before any ShipX call, adoption included.
      const payload = buildShipmentPayload(order);

      // Look up ShipX for a shipment already created under this order's reference
      // before creating a new one. Protects the API-success-then-DB-save-fails
      // window: a webhook retry after that failure must adopt the shipment it
      // already created in ShipX, not mint a second one that orphans the first.
      // A lookup failure is NOT swallowed — creating despite an unknown lookup
      // result could itself produce the duplicate this guards against.
      const existing = adoptExisting ? await inpost.findShipmentsByReference(order.id) : [];
      const shipment =
        existing.length > 0
          ? pickOldestShipment(existing, order.id)
          : await inpost.createShipment(payload);
      return toCarrierShipment(shipment);
    },

    async complete(progress, hooks) {
      // Schedule courier pickup via the ShipX dispatch_orders API (kurier only —
      // paczkomat and odbior need no dispatch order). On a replay this covers the
      // race where createShipment succeeded but createDispatchOrder threw.
      if (
        progress.deliveryMethod === 'kurier' &&
        !progress.dispatchOrderId &&
        hooks.saveDispatchOrderId
      ) {
        const dispatchPayload = buildDispatchOrderPayload(progress.shipmentId, new Date());
        const dispatchOrder = await inpost.createDispatchOrder(dispatchPayload);
        await hooks.saveDispatchOrderId(progress.orderId, String(dispatchOrder.id));
      }

      // Buy the shipment (commit the offer) unless it is known to be confirmed.
      // Runs after the dispatch block so a buy failure cannot skip dispatch
      // scheduling. On a replay this gate is intentionally broad: it catches
      // genuinely-stuck pre-buy orders (e.g. a prior webhook died after
      // createShipment but before buyShipment). The narrow window where a
      // shipment was just bought but the InPost confirmation webhook hasn't
      // landed yet is safe: ShipX rejects a duplicate /buy with a non-retryable
      // offer error (offer_unavailable / offer_not_found), which
      // isRetryableShipmentError (src/lib/carriers/errors.ts) swallows — returning 200 to Stripe and stopping further retries.
      if (progress.deliveryStatus !== LABEL_READY_STATUS) {
        await buyShipmentWhenReady(inpost, progress.shipmentId);
      }
    },

    getLabelPdf(shipmentId) {
      return inpost.getLabelPdf(shipmentId);
    },
  };
}
