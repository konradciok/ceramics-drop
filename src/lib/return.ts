/**
 * Create a return shipment for a paid order via the InPost ShipX API.
 *
 * The studio is the receiver; the customer drops the parcel at any InPost
 * parcel locker using the QR code / A6 PDF label emailed to them.
 *
 * Side effects are dependency-injected (mirrors `CreateShipmentDeps`) so the
 * orchestration is unit-testable without the Workers env.
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
  saveReturn: (
    orderId: string,
    data: { returnShipmentId: string; trackingNumber: string | null },
  ) => Promise<void>;
  inpost: InPostClient;
  studioConfig: StudioReturnConfig;
  emailReturnLabel: (order: OrderForReturn, labelPdf: ArrayBuffer, locale: string) => Promise<void>;
};

export type CreateReturnResult =
  | { ok: true; returnShipmentId: string; trackingNumber: string | null }
  | { ok: false; reason: 'order_not_found' | 'not_eligible' | 'already_returned' };

/**
 * Create a return shipment and email the customer the return label PDF.
 * Idempotent: returns `already_returned` if the order already has a return shipment.
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

  const payload = buildReturnShipmentPayload(order, deps.studioConfig);
  const shipment = await deps.inpost.createShipment(payload);
  const returnShipmentId = String(shipment.id);
  const trackingNumber = shipment.tracking_number ?? null;

  const labelPdf = await deps.inpost.getLabelPdf(returnShipmentId);
  await deps.emailReturnLabel(order, labelPdf, order.locale ?? 'pl');
  await deps.saveReturn(orderId, { returnShipmentId, trackingNumber });

  return { ok: true, returnShipmentId, trackingNumber };
}
