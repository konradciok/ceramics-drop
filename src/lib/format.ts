import type { Currency } from './currency';

/** Format a PLN amount the brand way: amount then unit — "90 zł". */
export const pln = (n: number): string => `${n} zł`;

/** Format a EUR amount: amount then unit — "22 €". */
export const eur = (n: number): string => `${n} €`;

/** Format a GBP amount: symbol then unit — "£22". */
export const gbp = (n: number): string => `£${n}`;

/** ISO 4217 code for a `Currency` (analytics/Stripe use the upper-case code). */
export type CurrencyCode = 'PLN' | 'EUR' | 'GBP';

/** Resolve a display currency to its price formatter and ISO currency code. */
export function currencyFormatter(currency: Currency): {
  fmt: (n: number) => string;
  code: CurrencyCode;
} {
  switch (currency) {
    case 'pln':
      return { fmt: pln, code: 'PLN' };
    case 'gbp':
      return { fmt: gbp, code: 'GBP' };
    case 'eur':
    default:
      return { fmt: eur, code: 'EUR' };
  }
}
