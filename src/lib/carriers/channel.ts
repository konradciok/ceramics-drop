import type { ShippingChannel } from './types';

/**
 * The channel an order ships through. `orders.shipping_channel` is NULL on
 * orders created before it existed; every one of those that has a shipment
 * went through ShipX, so NULL reads as `inpost_shipx`.
 */
export function shippingChannelOf(order: { shipping_channel?: string | null }): ShippingChannel {
  return order.shipping_channel === 'sendcloud' ? 'sendcloud' : 'inpost_shipx';
}
