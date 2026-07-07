/**
 * Create a return shipment for a paid order via the InPost ShipX API.
 *
 * The studio is the receiver; the customer drops the parcel at any InPost
 * parcel locker using the QR code / A6 PDF label emailed to them.
 *
 * Label delivery is intentionally deferred: after `createShipment` the
 * shipment is still in `created` state — the label only becomes available
 * once InPost moves it to `confirmed`. The `/api/inpost/webhook` handler
 * picks that up and emails the customer, mirroring the outbound label flow.
 *
 * Side effects are dependency-injected (mirrors `CreateShipmentDeps`) so
 * the orchestration is unit-testable without the Workers env.
 */
import { buildReturnShipmentPayload, type OrderForReturn, type StudioReturnConfig } from './shipx';
import type { InPostClient } from './inpost';

type ReturnableOrder = OrderForReturn & {
  status: string;
  delivery_method: string;
  inpost_return_shipment_id: string | null;
};

export type CreateReturnDeps = {
  loadOrder: (orderId: string) => Promise<ReturnableOrder | null>;
  /** True when the order has at least one ceramic line item (`order_items.variant IS NULL`). */
  hasCeramicItems: (orderId: string) => Promise<boolean>;
  saveReturn: (
    orderId: string,
    data: { returnShipmentId: string; trackingNumber: string | null },
  ) => Promise<void>;
  inpost: InPostClient;
  studioConfig: StudioReturnConfig;
};

export type CreateReturnResult =
  | { ok: true; returnShipmentId: string; trackingNumber: string | null }
  | { ok: false; reason: 'order_not_found' | 'not_eligible' | 'no_ceramic_items' | 'already_returned' };

/**
 * Create the return shipment and persist its ID. Idempotent: returns
 * `already_returned` if the order already has a return shipment.
 * The customer label email is sent by `/api/inpost/webhook` once the
 * shipment reaches `confirmed` status.
 */
export async function createOrderReturn(
  orderId: string,
  deps: CreateReturnDeps,
): Promise<CreateReturnResult> {
  const order = await deps.loadOrder(orderId);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (order.status !== 'paid') return { ok: false, reason: 'not_eligible' };
  if (order.delivery_method === 'odbior') return { ok: false, reason: 'not_eligible' };
  if (order.inpost_return_shipment_id) return { ok: false, reason: 'already_returned' };
  // Print-only orders are fulfilled by Prodigi (EU/UK courier) — the InPost
  // locker return path makes no sense for them. POD defect handling stays a
  // manual/support path.
  if (!(await deps.hasCeramicItems(orderId))) return { ok: false, reason: 'no_ceramic_items' };

  let payload;
  try {
    payload = buildReturnShipmentPayload(order, deps.studioConfig);
  } catch {
    return { ok: false, reason: 'not_eligible' };
  }
  const shipment = await deps.inpost.createShipment(payload);
  const returnShipmentId = String(shipment.id);
  const trackingNumber = shipment.tracking_number ?? null;

  // Persist ID before any further side effects so that a retry doesn't create
  // a second ShipX shipment (guard: `.is('inpost_return_shipment_id', null)`).
  await deps.saveReturn(orderId, { returnShipmentId, trackingNumber });

  return { ok: true, returnShipmentId, trackingNumber };
}
