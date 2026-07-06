/**
 * Create an InPost shipment for a freshly-paid order.
 *
 * Side effects are dependency-injected (mirrors `WebhookDeps`) so the
 * orchestration is unit-testable without the Workers env. The Stripe webhook
 * route wires the real Supabase + InPost implementations.
 */
import * as Sentry from '@sentry/nextjs';
import {
  buildShipmentPayload,
  buildDispatchOrderPayload,
  needsShipment,
  pickBuyableOffer,
  LABEL_READY_STATUS,
  type OrderForShipment,
} from './shipx';
import type { InPostClient, ShipxShipment } from './inpost';

export type CreateShipmentDeps = {
  loadOrder: (paymentIntentId: string) => Promise<OrderForShipment | null>;
  saveShipment: (
    orderId: string,
    data: { shipmentId: string; trackingNumber: string | null; status: string },
  ) => Promise<void>;
  inpost: InPostClient;
  /** If provided, a courier dispatch order is created and its ID is persisted. */
  saveDispatchOrderId?: (orderId: string, dispatchOrderId: string) => Promise<void>;
};

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

/**
 * Create the shipment and persist its id/tracking/status. Idempotent and a
 * no-op for studio pickup. Never assume it can throw out of the payment
 * webhook — callers wrap it (the sale is already committed).
 */
export async function createOrderShipment(
  paymentIntentId: string,
  deps: CreateShipmentDeps,
): Promise<void> {
  const order = await deps.loadOrder(paymentIntentId);
  if (!order) return;
  if (!needsShipment(order.delivery_method)) return; // odbior → no carrier shipment

  // Shipment already created (Stripe webhook replay). Still schedule dispatch if it
  // was never persisted — covers the race where createShipment succeeded but
  // createDispatchOrder threw, causing a webhook retry that would otherwise no-op here.
  if (order.inpost_shipment_id) {
    if (
      order.delivery_method === 'kurier' &&
      !order.inpost_dispatch_order_id &&
      deps.saveDispatchOrderId
    ) {
      const dispatchPayload = buildDispatchOrderPayload(order.inpost_shipment_id, new Date());
      const dispatchOrder = await deps.inpost.createDispatchOrder(dispatchPayload);
      await deps.saveDispatchOrderId(order.id, String(dispatchOrder.id));
    }
    // Retry buy if the shipment was not yet confirmed. This gate is intentionally
    // broad: it catches genuinely-stuck pre-buy orders (e.g. prior webhook died
    // after createShipment but before buyShipment). The narrow window where a
    // shipment was just bought but the InPost confirmation webhook hasn't landed
    // yet is safe: ShipX rejects a duplicate /buy with a non-retryable offer
    // error (offer_unavailable / offer_not_found), which shouldRethrowShipmentError
    // swallows — returning 200 to Stripe and stopping further retries.
    if (order.delivery_status !== LABEL_READY_STATUS) {
      await buyShipmentWhenReady(deps.inpost, order.inpost_shipment_id);
    }
    return;
  }

  const payload = buildShipmentPayload(order);

  // Look up ShipX for a shipment already created under this order's reference
  // before creating a new one. Protects the API-success-then-DB-save-fails
  // window: a webhook retry after that failure must adopt the shipment it
  // already created in ShipX, not mint a second one that orphans the first.
  // A lookup failure is NOT swallowed — creating despite an unknown lookup
  // result could itself produce the duplicate this guards against.
  const existing = await deps.inpost.findShipmentsByReference(order.id);
  const shipment =
    existing.length > 0
      ? pickOldestShipment(existing, order.id)
      : await deps.inpost.createShipment(payload);
  const shipmentId = String(shipment.id);

  await deps.saveShipment(order.id, {
    shipmentId,
    trackingNumber: shipment.tracking_number ?? null,
    status: shipment.status,
  });

  // Schedule courier pickup immediately via the ShipX dispatch_orders API.
  // Only applies to kurier (paczkomat and odbior need no dispatch order).
  if (order.delivery_method === 'kurier' && deps.saveDispatchOrderId) {
    const dispatchPayload = buildDispatchOrderPayload(shipmentId, new Date());
    const dispatchOrder = await deps.inpost.createDispatchOrder(dispatchPayload);
    await deps.saveDispatchOrderId(order.id, String(dispatchOrder.id));
  }

  // Buy the shipment (commit the offer). Runs for ALL methods (paczkomat + kurier).
  // Placed after the kurier dispatch block so a buy failure cannot skip dispatch scheduling.
  await buyShipmentWhenReady(deps.inpost, shipmentId);
}
