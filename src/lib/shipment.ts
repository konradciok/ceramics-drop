/**
 * Create the carrier shipment for a freshly-paid order — carrier-agnostic.
 *
 * Side effects are dependency-injected (mirrors `WebhookDeps`) so the
 * orchestration is unit-testable without the Workers env. The Stripe webhook
 * route, the admin actions and the orders CLI wire the real Supabase
 * persistence and a carrier adapter (src/lib/carriers/).
 */
import { needsShipment } from '@/lib/delivery/validate';
import { shippingChannelOf } from '@/lib/carriers/channel';
import type { CarrierResolver, OrderForShipment } from '@/lib/carriers/types';

export type CreateShipmentDeps = {
  loadOrder: (paymentIntentId: string) => Promise<OrderForShipment | null>;
  saveShipment: (
    orderId: string,
    data: { shipmentId: string; trackingNumber: string | null; status: string; trackingUrl: string | null },
  ) => Promise<void>;
  /** Picks the adapter for the order's `shipping_channel` (src/lib/carriers/index.ts). */
  carriers: CarrierResolver;
  /** If provided, a courier dispatch order is created and its ID is persisted. */
  saveDispatchOrderId?: (orderId: string, dispatchOrderId: string) => Promise<void>;
};

/**
 * Create the shipment and persist its id/tracking/status, then let the carrier
 * finish it. Idempotent and a no-op for studio pickup. Never assume it can
 * throw out of the payment webhook — callers wrap it (the sale is already
 * committed) and ask `isRetryableShipmentError` (src/lib/carriers/errors.ts)
 * whether to rethrow.
 */
export async function createOrderShipment(
  paymentIntentId: string,
  deps: CreateShipmentDeps,
  opts?: { adoptExisting?: boolean },
): Promise<void> {
  const order = await deps.loadOrder(paymentIntentId);
  if (!order) return;
  if (!needsShipment(order.delivery_method)) return; // odbior → no carrier shipment

  const carrier = deps.carriers(shippingChannelOf(order));
  const hooks = { saveDispatchOrderId: deps.saveDispatchOrderId };

  // Shipment already persisted (webhook replay, or a retry after a failed
  // post-create step): only finish it — never create a second one.
  if (order.inpost_shipment_id) {
    await carrier.complete(
      {
        orderId: order.id,
        deliveryMethod: order.delivery_method,
        shipmentId: order.inpost_shipment_id,
        dispatchOrderId: order.inpost_dispatch_order_id,
        deliveryStatus: order.delivery_status ?? null,
      },
      hooks,
    );
    return;
  }

  const shipment = await carrier.create(order, { adoptExisting: opts?.adoptExisting !== false });

  // Persist before any post-create step, so a failure there leaves the id saved
  // and the next attempt takes the replay branch above.
  await deps.saveShipment(order.id, {
    shipmentId: shipment.id,
    trackingNumber: shipment.trackingNumber,
    status: shipment.status,
    trackingUrl: shipment.trackingUrl ?? null,
  });

  await carrier.complete(
    {
      orderId: order.id,
      deliveryMethod: order.delivery_method,
      shipmentId: shipment.id,
      dispatchOrderId: null,
      deliveryStatus: null,
    },
    hooks,
  );
}
