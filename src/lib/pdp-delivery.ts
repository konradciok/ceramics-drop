import { deliveryRatesForZone, shippingOfCurrency, COURIER_ENABLED, STUDIO_PICKUP_ENABLED, type ShippingZone } from './pricing';
import { DESTINATIONS, type DestinationCountry } from './delivery/destinations';
import { deliveryRatesFor } from './shipping-rates/delivery-rates';
import type { ShippingRatesBundle } from './shipping-rates/last-known-good';
import type { Currency } from './currency';

export type PdpDeliveryRow =
  | { kind: 'pickup'; price: number }
  /** The visitor's own country: the one locker row when it is known. */
  | { kind: 'locker-country'; country: DestinationCountry; price: number }
  /** One row per zone checkout offers, when the visitor's country is a guess. */
  | { kind: 'locker-zone'; zone: ShippingZone; multiZone: boolean; price: number }
  | { kind: 'courier'; price: number };

export type PdpDeliveryQuote = {
  rows: PdpDeliveryRow[];
  /** Item + locker delivery to the visitor's (known or guessed) country. */
  total: number;
  /** The total is what checkout will charge: country known and the locker the only method on offer. */
  exact: boolean;
  /** Business days the visitor's lane promises — only when the country is known. */
  transitDays: number | null;
};

/**
 * The PDP delivery block's numbers. Every price comes from the CMS-published
 * tables checkout charges from (getShippingRatesForDisplay), never the
 * SHIPPING_* constants. Delivery is a flat fee per order, so the locker price
 * is the same whether the cart holds this one piece or several.
 */
export function pdpDeliveryQuote({
  item,
  currency,
  shipping,
  countries,
  visitor,
  courierEnabled = COURIER_ENABLED,
  pickupEnabled = STUDIO_PICKUP_ENABLED,
}: {
  item: number;
  currency: Currency;
  shipping: ShippingRatesBundle;
  /** checkoutCountries() — never empty. */
  countries: readonly DestinationCountry[];
  /** resolveCheckoutCountry() — the cart's preselection and whether it is the visitor's real country. */
  visitor: { country: DestinationCountry; known: boolean };
  courierEnabled?: boolean;
  pickupEnabled?: boolean;
}): PdpDeliveryQuote {
  const visitorRates = deliveryRatesFor(shipping, visitor.country);
  const locker = shippingOfCurrency(currency, 'paczkomat', visitorRates);

  const rows: PdpDeliveryRow[] = [];
  // Studio pickup is free unless the operator publishes a price for it (odbior is editable, like the cart label).
  if (pickupEnabled) rows.push({ kind: 'pickup', price: shippingOfCurrency(currency, 'odbior', visitorRates) });
  if (visitor.known) {
    rows.push({ kind: 'locker-country', country: visitor.country, price: locker });
  } else {
    const zones = [...new Set(countries.map((c) => DESTINATIONS[c].zone))];
    for (const zone of zones) {
      rows.push({
        kind: 'locker-zone',
        zone,
        multiZone: zones.length > 1,
        price: shippingOfCurrency(currency, 'paczkomat', deliveryRatesForZone(shipping.domestic, shipping.lockers, zone)),
      });
    }
  }
  if (courierEnabled) rows.push({ kind: 'courier', price: shippingOfCurrency(currency, 'kurier', visitorRates) });

  return {
    rows,
    total: item + locker,
    exact: visitor.known && !courierEnabled && !pickupEnabled,
    transitDays: visitor.known ? DESTINATIONS[visitor.country].transitDays : null,
  };
}
