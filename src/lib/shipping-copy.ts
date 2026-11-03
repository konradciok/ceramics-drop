import { currencyFormatter } from './format';
import type { Currency } from './currency';
import type { DomesticShippingRates } from './pricing';

/**
 * The /dostawa-i-zwroty copy quotes the studio's domestic (InPost) shipping:
 * PLN in pl/en/es and EUR in de — the same currencies the previously
 * hard-coded text used, so wording does not change when the amounts become
 * placeholders.
 */
export function shippingCopyCurrency(locale: string): Currency {
  return locale === 'de' ? 'eur' : 'pln';
}

/**
 * ICU values for `shipping.s1P` / `s1Li1` / `s1Li1b` ({locker}, {courier}),
 * formatted from the CMS-published domestic table — the one checkout charges
 * from (getShippingRatesForDisplay) — so the copy can never drift from it.
 */
export function shippingCopyValues(
  locale: string,
  domestic: DomesticShippingRates,
): { locker: string; courier: string } {
  const currency = shippingCopyCurrency(locale);
  const { fmt } = currencyFormatter(currency);
  return { locker: fmt(domestic[currency].paczkomat), courier: fmt(domestic[currency].kurier) };
}
