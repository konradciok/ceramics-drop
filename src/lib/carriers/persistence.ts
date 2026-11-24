/**
 * The `orders` columns shipment creation reads and writes — shared by every
 * caller of createOrderShipment (Stripe webhook, admin actions, orders CLI) so
 * a new carrier column is added in one place.
 */
import type { CreateShipmentDeps } from '@/lib/shipment';

/** `select()` list for loadOrder → OrderForShipment. */
export const ORDER_FOR_SHIPMENT_COLUMNS =
  'id, delivery_method, email, receiver_first_name, receiver_last_name, ' +
  'receiver_phone, inpost_target_point, shipping_address, inpost_shipment_id, ' +
  'inpost_dispatch_order_id, delivery_status, shipping_channel, delivery_country, ' +
  'delivery_point, shipment_attempt';

type SavedShipment = Parameters<CreateShipmentDeps['saveShipment']>[1];

/** The `update()` patch for a freshly created shipment. */
export function shipmentSavePatch(d: SavedShipment): Record<string, string | null> {
  return {
    inpost_shipment_id: d.shipmentId,
    inpost_tracking_number: d.trackingNumber,
    delivery_status: d.status,
    // Only Sendcloud returns a tracking link; ShipX rows keep the column NULL.
    ...(d.trackingUrl ? { tracking_url: d.trackingUrl } : {}),
  };
}
