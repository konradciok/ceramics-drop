/**
 * Create an InPost shipment for a freshly-paid order.
 *
 * Side effects are dependency-injected (mirrors `WebhookDeps`) so the
 * orchestration is unit-testable without the Workers env. The Stripe webhook
 * route wires the real Supabase + InPost implementations.
 */
import { buildShipmentPayload, needsShipment, type OrderForShipment } from './shipx';
import type { InPostClient } from './inpost';

export type CreateShipmentDeps = {
  loadOrder: (paymentIntentId: string) => Promise<OrderForShipment | null>;
  saveShipment: (
    orderId: string,
    data: { shipmentId: string; trackingNumber: string | null; status: string },
  ) => Promise<void>;
  inpost: InPostClient;
};

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
  if (order.inpost_shipment_id) return; // already shipped (idempotent on webhook replay)

  const payload = buildShipmentPayload(order);
  const shipment = await deps.inpost.createShipment(payload);

  await deps.saveShipment(order.id, {
    shipmentId: String(shipment.id),
    trackingNumber: shipment.tracking_number ?? null,
    status: shipment.status,
  });
}
