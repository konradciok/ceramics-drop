/* ============================================================
   Unified customer-facing order status (plan §5.3).
   ------------------------------------------------------------
   Pure mapper: orders.status × fulfilment_type × per-path fulfilment state →
   one of 8 statuses (i18n keys under `account.status.*` in all four locales)
   plus an optional tracking block. Only `paid`/`refunded` orders reach the
   account UI (`pending/failed/expired` are never shown), but the mapper stays
   total over its inputs — unknown states degrade conservatively.
   ============================================================ */
import { httpsUrlOrNull, inpostTrackingUrl } from '@/lib/tracking';

export type CustomerOrderStatus =
  | 'processing'
  | 'inProduction'
  | 'shipped'
  | 'readyForPickup'
  | 'delivered'
  | 'awaitingPickup'
  | 'refunded'
  | 'cancelled';

export type CustomerTracking = {
  number: string;
  carrier: string | null;
  /** https-validated at render — anything else renders as bare text. */
  url: string | null;
};

export type CustomerStatusInput = {
  /** orders.status */
  status: string;
  /** orders.fulfilment_type: inpost | prodigi | pickup (null on legacy rows). */
  fulfilmentType: string | null;
  /** orders.delivery_method: paczkomat | kurier | odbior */
  deliveryMethod: string | null;
  /** orders.delivery_status (InPost webhook mirror) — ceramics only. */
  deliveryStatus: string | null;
  /** orders.inpost_tracking_number — ceramics only. */
  inpostTrackingNumber: string | null;
  /** Latest fulfilment_jobs.status — prints only. */
  latestJobStatus: string | null;
  /** Persisted prodigi_orders tracking columns — prints only. */
  prodigiTracking: {
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
  } | null;
};

export type CustomerStatusResult = {
  status: CustomerOrderStatus;
  tracking: CustomerTracking | null;
};

// InPost delivery_status buckets (conservative; see src/lib/shipx.ts consumers).
const INPOST_PRE_SHIPMENT = new Set(['created', 'offer_selected', 'offers_prepared', 'confirmed']);
const INPOST_READY_FOR_PICKUP = new Set(['ready_to_pickup', 'pickup_reminder_sent']);
const INPOST_DELIVERED = new Set(['delivered']);

// fulfilment_jobs.status buckets (see src/server/fulfilment/status-map.ts).
const JOB_PROCESSING = new Set(['queued', 'fulfilment_submitting', 'fulfilment_submitted']);
const JOB_SHIPPED = new Set(['shipped', 'completed']);

/** Map one order (+ per-path fulfilment state) to its customer-facing status. */
export function customerOrderStatus(input: CustomerStatusInput): CustomerStatusResult {
  // Refunds override everything — no tracking block on a refunded order.
  if (input.status === 'refunded') return { status: 'refunded', tracking: null };

  // Studio pickup has no shipment at all.
  if (input.fulfilmentType === 'pickup' || input.deliveryMethod === 'odbior') {
    return { status: 'awaitingPickup', tracking: null };
  }

  if (input.fulfilmentType === 'prodigi') return printStatus(input);
  return ceramicStatus(input);
}

function printStatus(input: CustomerStatusInput): CustomerStatusResult {
  const job = input.latestJobStatus;
  if (job === 'cancelled') return { status: 'cancelled', tracking: null };
  if (job === 'in_production') return { status: 'inProduction', tracking: null };
  if (job !== null && JOB_SHIPPED.has(job)) {
    const t = input.prodigiTracking;
    const tracking: CustomerTracking | null = t?.trackingNumber
      ? {
          number: t.trackingNumber,
          carrier: t.carrier ?? null,
          url: httpsUrlOrNull(t.trackingUrl),
        }
      : null;
    return { status: 'shipped', tracking };
  }
  // queued / submitting / submitted / failed_action_required (studio-side
  // repair state — the buyer just sees production underway) / no job yet.
  if (job === null || JOB_PROCESSING.has(job) || job === 'failed_action_required') {
    return { status: 'processing', tracking: null };
  }
  // Unknown future status — the safest customer-facing story is "processing".
  return { status: 'processing', tracking: null };
}

function ceramicStatus(input: CustomerStatusInput): CustomerStatusResult {
  const raw = input.deliveryStatus?.trim().toLowerCase() ?? null;
  const number = input.inpostTrackingNumber?.trim() || null;
  const tracking: CustomerTracking | null = number
    ? { number, carrier: 'InPost', url: inpostTrackingUrl(number) }
    : null;

  if (raw === null || INPOST_PRE_SHIPMENT.has(raw)) {
    // No shipment movement yet — a tracking number may already exist (label
    // bought), but the parcel isn't on its way; keep the quiet status.
    return { status: 'processing', tracking };
  }
  if (INPOST_READY_FOR_PICKUP.has(raw)) return { status: 'readyForPickup', tracking };
  if (INPOST_DELIVERED.has(raw)) return { status: 'delivered', tracking };
  // Any other known-movement or unknown status: shipped when a tracking number
  // exists, else still processing (conservative bucket from the plan).
  return tracking ? { status: 'shipped', tracking } : { status: 'processing', tracking: null };
}
