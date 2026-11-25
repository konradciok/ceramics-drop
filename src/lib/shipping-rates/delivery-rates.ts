/**
 * The per-method shipping table a destination is shown and charged.
 *
 * The locker (`paczkomat`) price comes from the destination's zone in the
 * `lockers` resource; courier and studio pickup keep the legacy `domestic`
 * table (both are switched off at checkout). Every surface that displays or
 * charges a shipping price — cart, PDP, JSON-LD, the /dostawa-i-zwroty copy,
 * checkout — resolves its table through here, so the locker price has exactly
 * one source.
 */
import { deliveryRatesForZone, type DomesticShippingRates } from '@/lib/pricing';
import type { ShippingChannel } from '@/lib/carriers/types';
import {
  DESTINATIONS,
  PRIMARY_DESTINATION_COUNTRY,
  type Destination,
  type DestinationCountry,
} from '@/lib/delivery/destinations';
import type { ShippingRatesBundle } from './last-known-good';

export function deliveryRatesFor(
  rates: Pick<ShippingRatesBundle, 'domestic' | 'lockers'>,
  country: DestinationCountry = PRIMARY_DESTINATION_COUNTRY,
): DomesticShippingRates {
  return deliveryRatesForZone(rates.domestic, rates.lockers, DESTINATIONS[country].zone);
}

/** One country the cart offers, with the table it is shown and charged from. */
export type CheckoutDestinationOption = {
  country: DestinationCountry;
  channel: ShippingChannel;
  /** Sendcloud carrier the point picker filters on (Sendcloud channel only). */
  carrier: Destination['sendcloudCarrier'];
  rates: DomesticShippingRates;
};

/** The cart's destination list, resolved server-side from the published rates. */
export function checkoutDestinationOptions(
  rates: Pick<ShippingRatesBundle, 'domestic' | 'lockers'>,
  countries: readonly DestinationCountry[],
): CheckoutDestinationOption[] {
  return countries.map((country) => ({
    country,
    channel: DESTINATIONS[country].channel,
    carrier: DESTINATIONS[country].sendcloudCarrier,
    rates: deliveryRatesFor(rates, country),
  }));
}
