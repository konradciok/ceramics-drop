import { currencyFormatter } from './format';
import type { Currency } from './currency';
import type { ShippingRatesBundle } from './shipping-rates/last-known-good';

/**
 * The /dostawa-i-zwroty copy quotes PLN on the Polish page and EUR on the
 * en/es/de pages — each locale's default display currency. The page is the
 * same for every visitor, so it does not follow the `currency_pref` cookie.
 */
export function shippingCopyCurrency(locale: string): Currency {
  return locale === 'pl' ? 'pln' : 'eur';
}

/**
 * ICU values for `shipping.s1Li1` ({lockerEs}), `shipping.s1Li1c` ({lockerEu})
 * and the courier line `shipping.s1Li1b` ({courier}, shown only with
 * COURIER_ENABLED), formatted from the CMS-published tables checkout charges
 * from (getShippingRatesForDisplay) — so the copy can never drift from them.
 * The locker prices are the two `lockers` zones: Spain, and every other
 * country checkout ships to.
 */
export function shippingCopyValues(
  locale: string,
  rates: Pick<ShippingRatesBundle, 'domestic' | 'lockers'>,
): { lockerEs: string; lockerEu: string; courier: string } {
  const currency = shippingCopyCurrency(locale);
  const { fmt } = currencyFormatter(currency);
  return {
    lockerEs: fmt(rates.lockers.es[currency]),
    lockerEu: fmt(rates.lockers.eu[currency]),
    courier: fmt(rates.domestic[currency].kurier),
  };
}
