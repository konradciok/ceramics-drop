/**
 * Destination registry for shipping from mainland Spain via Sendcloud
 * (docs/plans/2026-11-24-inpost-international-shipping-plan.md §3). The single
 * place a destination country is configured. Pure data, no I/O.
 *
 * Not reachable from checkout yet: checkout still ships PL-only through ShipX
 * (CHECKOUT_DESTINATION below) until the Spain cutover flips `enabled`.
 */
import type { ShippingChannel } from '@/lib/carriers/types';

export const DESTINATION_COUNTRIES = ['ES', 'PT', 'FR', 'DE', 'AT', 'BE', 'NL', 'LU', 'IT', 'PL'] as const;
export type DestinationCountry = (typeof DESTINATION_COUNTRIES)[number];

/** Price zone: Spain vs every other country (owner decision 2026-11-24). */
export type ShippingZone = 'es' | 'eu';

export type Destination = {
  country: DestinationCountry;
  /** Offered at checkout from Spain. Flipped on at the Spain cutover. */
  enabled: boolean;
  zone: ShippingZone;
  /** Sendcloud carrier code for this lane. */
  sendcloudCarrier: 'inpost_es' | 'inpost_global';
  /**
   * Sendcloud `shipping_option_code` for locker/point delivery on this lane.
   * null until verified against the owner's Sendcloud account with
   * `POST /shipping-options` — a shipment to a country without one fails
   * closed (non-retryable `no_shipping_option`).
   */
  sendcloudShippingOption: string | null;
  /** Business days promised in copy and JSON-LD after fulfilment. */
  transitDays: number;
};

function destination(
  country: DestinationCountry,
  zone: ShippingZone,
  transitDays: number,
  sendcloudCarrier: Destination['sendcloudCarrier'] = 'inpost_es',
): Destination {
  return { country, enabled: false, zone, sendcloudCarrier, sendcloudShippingOption: null, transitDays };
}

export const DESTINATIONS: Record<DestinationCountry, Destination> = {
  ES: destination('ES', 'es', 4),
  PT: destination('PT', 'eu', 7),
  FR: destination('FR', 'eu', 7),
  DE: destination('DE', 'eu', 7),
  AT: destination('AT', 'eu', 7),
  BE: destination('BE', 'eu', 7),
  NL: destination('NL', 'eu', 7),
  LU: destination('LU', 'eu', 7),
  IT: destination('IT', 'eu', 7),
  // Sendcloud's InPost ES conditions do not list Spain→Poland (plan decision A):
  // the carrier may become inpost_global once the lane check settles it.
  PL: destination('PL', 'eu', 7),
};

export function isDestinationCountry(code: unknown): code is DestinationCountry {
  return typeof code === 'string' && (DESTINATION_COUNTRIES as readonly string[]).includes(code);
}

/** The destination for a country code, or null when it is not one we ship to. */
export function destinationFor(code: string | null | undefined): Destination | null {
  return isDestinationCountry(code) ? DESTINATIONS[code] : null;
}

/**
 * Whether paid orders on the ShipX channel get an automatic ShipX shipment.
 * Off since 2026-11-24: the stock is in mainland Spain, and a ShipX label can
 * only be handed over in Poland — an automatic one would be bought for nothing.
 * Until the InPost España contract (Spain → Polish lockers) is wired in, the
 * studio ships these orders by hand on inpost.es to the Paczkomat the customer
 * chose (orders.inpost_target_point). The Stripe webhook, admin and orders CLI
 * all skip ShipX creation while this is false.
 */
export const SHIPX_AUTOMATIC_SHIPMENTS = false;

/** Where today's checkout ships: Poland, through InPost ShipX (until the Spain cutover). */
export const CHECKOUT_DESTINATION: { country: DestinationCountry; channel: ShippingChannel } = {
  country: 'PL',
  channel: 'inpost_shipx',
};
