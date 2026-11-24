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
import { CHECKOUT_DESTINATION, DESTINATIONS, type DestinationCountry } from '@/lib/delivery/destinations';
import type { ShippingRatesBundle } from './last-known-good';

export function deliveryRatesFor(
  rates: Pick<ShippingRatesBundle, 'domestic' | 'lockers'>,
  country: DestinationCountry = CHECKOUT_DESTINATION.country,
): DomesticShippingRates {
  return deliveryRatesForZone(rates.domestic, rates.lockers, DESTINATIONS[country].zone);
}
