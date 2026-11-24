/**
 * Destination registry for shipping from mainland Spain
 * (docs/plans/2026-11-24-inpost-international-shipping-plan.md §3). The single
 * place a destination country is configured. Pure data, no I/O.
 *
 * Poland stays on the InPost ShipX channel (InPost Poland Geowidget; labels
 * bought by hand on inpost.es while SHIPX_AUTOMATIC_SHIPMENTS is off) because
 * Sendcloud has no Spain → Poland lane. Every other country ships through
 * Sendcloud (InPost España lockers / Punto Pack points) once `enabled`.
 */
import type { ShippingChannel } from '@/lib/carriers/types';
import type { ShippingZone } from '@/lib/pricing';

export type { ShippingZone };

export const DESTINATION_COUNTRIES = ['ES', 'PT', 'FR', 'DE', 'AT', 'BE', 'NL', 'LU', 'IT', 'PL'] as const;
export type DestinationCountry = (typeof DESTINATION_COUNTRIES)[number];

export type Destination = {
  country: DestinationCountry;
  /** Offered at checkout (unless the CHECKOUT_COUNTRIES runtime var overrides the flags). */
  enabled: boolean;
  zone: ShippingZone;
  /** Which carrier integration ships it — and so which point picker checkout shows. */
  channel: ShippingChannel;
  /** Sendcloud carrier code for this lane (the picker's `carriers` filter). */
  sendcloudCarrier: 'inpost_es' | 'inpost_global';
  /**
   * Sendcloud `shipping_option_code` for locker/point delivery on this lane.
   * null = no verified lane: the country can never be offered at checkout
   * (checkoutCountries drops it) and a shipment to it fails closed
   * (non-retryable `no_shipping_option`).
   */
  sendcloudShippingOption: string | null;
  /** Business days promised in copy and JSON-LD after fulfilment. */
  transitDays: number;
};

// Verified on the owner's Sendcloud account from the mainland sender address
// (29640 Fuengirola) on 2026-11-24 with POST /shipping-options. Re-run a lane
// check before trusting them after an account change.
const INPOST_ES_NATIONAL = 'inpost_es:service_point,national_c2c';
const INPOST_ES_INTERNATIONAL = 'inpost_es:service_point,international_c2c';

function sendcloudLane(
  country: DestinationCountry,
  zone: ShippingZone,
  transitDays: number,
  sendcloudShippingOption: string | null,
): Destination {
  return {
    country,
    // Off until the copy for shipping to more countries is approved (plan PR 5).
    enabled: false,
    zone,
    channel: 'sendcloud',
    sendcloudCarrier: 'inpost_es',
    sendcloudShippingOption,
    transitDays,
  };
}

export const DESTINATIONS: Record<DestinationCountry, Destination> = {
  ES: sendcloudLane('ES', 'es', 4, INPOST_ES_NATIONAL),
  PT: sendcloudLane('PT', 'eu', 7, INPOST_ES_INTERNATIONAL),
  FR: sendcloudLane('FR', 'eu', 7, INPOST_ES_INTERNATIONAL),
  DE: sendcloudLane('DE', 'eu', 7, INPOST_ES_INTERNATIONAL),
  // No Sendcloud option from Spain to Austria (lane check 2026-11-24).
  AT: sendcloudLane('AT', 'eu', 7, null),
  BE: sendcloudLane('BE', 'eu', 7, INPOST_ES_INTERNATIONAL),
  NL: sendcloudLane('NL', 'eu', 7, INPOST_ES_INTERNATIONAL),
  // An option exists, but the point search found no InPost ES points in
  // Luxembourg — a buyer could never pick one, so the lane stays closed.
  LU: sendcloudLane('LU', 'eu', 7, null),
  IT: sendcloudLane('IT', 'eu', 7, INPOST_ES_INTERNATIONAL),
  // Sendcloud has no Spain → Poland lane: Poland keeps the ShipX channel and
  // the InPost Poland Geowidget, labelled by hand (SHIPX_AUTOMATIC_SHIPMENTS).
  PL: {
    country: 'PL',
    enabled: true,
    zone: 'eu',
    channel: 'inpost_shipx',
    sendcloudCarrier: 'inpost_es',
    sendcloudShippingOption: null,
    transitDays: 7,
  },
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

/**
 * The country the storefront's price displays quote (PDP, JSON-LD, the
 * /dostawa-i-zwroty copy) and the one a checkout body without
 * `delivery_country` is for (a cart page loaded before country selection).
 */
export const PRIMARY_DESTINATION_COUNTRY: DestinationCountry = 'PL';

/** Whether a lane can take an order at all: a Sendcloud lane needs a verified shipping option. */
export function isShippable(destination: Destination): boolean {
  return destination.channel === 'inpost_shipx' || destination.sendcloudShippingOption !== null;
}

/**
 * The countries checkout offers, in registry order. `override` — the
 * CHECKOUT_COUNTRIES runtime var, a comma-separated list such as "PL,ES" —
 * replaces the `enabled` flags (the hermetic E2E server; a pre-launch smoke
 * test). A country without a shippable lane is dropped either way, and an
 * override that names nothing usable falls back to the flags. Server-side
 * only: the client gets the resolved list from the cart page.
 */
export function checkoutCountries(override: string | undefined = process.env.CHECKOUT_COUNTRIES): DestinationCountry[] {
  const shippable = DESTINATION_COUNTRIES.filter((c) => isShippable(DESTINATIONS[c]));
  const requested = new Set(
    (override ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  );
  const fromOverride = shippable.filter((c) => requested.has(c));
  if (fromOverride.length > 0) return fromOverride;
  const fromFlags = shippable.filter((c) => DESTINATIONS[c].enabled);
  return fromFlags.length > 0 ? fromFlags : [PRIMARY_DESTINATION_COUNTRY];
}

// Plan §3: the visitor's country when we ship there, otherwise by locale.
const LOCALE_DEFAULT_COUNTRY: Record<string, DestinationCountry> = { pl: 'PL', es: 'ES', de: 'DE', en: 'ES' };

/** The country checkout preselects. `countries` is never empty (checkoutCountries). */
export function defaultCheckoutCountry(
  countries: readonly DestinationCountry[],
  { ipCountry, locale }: { ipCountry?: string | null; locale: string },
): DestinationCountry {
  const ip = ipCountry?.trim().toUpperCase();
  if (isDestinationCountry(ip) && countries.includes(ip)) return ip;
  const byLocale = LOCALE_DEFAULT_COUNTRY[locale];
  if (byLocale && countries.includes(byLocale)) return byLocale;
  return countries[0] ?? PRIMARY_DESTINATION_COUNTRY;
}
