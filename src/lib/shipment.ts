/**
 * Create an InPost shipment for a freshly-paid order.
 *
 * Side effects are dependency-injected (mirrors `WebhookDeps`) so the
 * orchestration is unit-testable without the Workers env. The Stripe webhook
 * route wires the real Supabase + InPost implementations.
 */
import { buildShipmentPayload, buildDispatchOrderPayload, needsShipment, type OrderForShipment } from './shipx';
import type { InPostClient } from './inpost';

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
    return;
  }

  const payload = buildShipmentPayload(order);
  const shipment = await deps.inpost.createShipment(payload);
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
}
