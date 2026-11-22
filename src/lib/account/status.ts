/* ============================================================
   Unified customer-facing order status (plan §5.3).
   ------------------------------------------------------------
   Pure mapper: orders.status × fulfilment_type × InPost delivery state →
   one of 8 statuses (i18n keys under `account.status.*` in all four locales)
   plus an optional tracking block. Only `paid`/`refunded` orders reach the
   account UI (`pending/failed/expired` are never shown), but the mapper stays
   total over its inputs — unknown states degrade conservatively.
   ============================================================ */
import { inpostTrackingUrl } from '@/lib/tracking';

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
};

export type CustomerStatusResult = {
  status: CustomerOrderStatus;
  tracking: CustomerTracking | null;
};

// InPost delivery_status buckets (conservative; see src/lib/shipx.ts consumers).
const INPOST_PRE_SHIPMENT = new Set(['created', 'offer_selected', 'offers_prepared', 'confirmed']);
const INPOST_READY_FOR_PICKUP = new Set(['ready_to_pickup', 'pickup_reminder_sent']);
const INPOST_DELIVERED = new Set(['delivered']);

/** Map one order (+ per-path fulfilment state) to its customer-facing status. */
export function customerOrderStatus(input: CustomerStatusInput): CustomerStatusResult {
  // Refunds override everything — no tracking block on a refunded order.
  if (input.status === 'refunded') return { status: 'refunded', tracking: null };

  // A `failed` order is terminal and possibly a captured-then-refunded payment
  // (M-5's private-sale double-paid path). Account queries already exclude it,
  // but the mapper must not degrade it into a normal delivery state.
  if (input.status === 'failed') return { status: 'cancelled', tracking: null };

  // Studio pickup has no shipment at all.
  if (input.fulfilmentType === 'pickup' || input.deliveryMethod === 'odbior') {
    return { status: 'awaitingPickup', tracking: null };
  }

  // Retired Prodigi print orders (prints moved to anna-ciok.com, 2026-11).
  // Every settled one was fulfilled before the fulfilment tables were
  // dropped, so a paid print order reads as shipped — without tracking.
  if (input.fulfilmentType === 'prodigi') return { status: 'shipped', tracking: null };
  return ceramicStatus(input);
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
