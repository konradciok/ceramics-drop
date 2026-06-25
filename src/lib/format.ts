/** Format a PLN amount the brand way: amount then unit — "90 zł". */
export const pln = (n: number): string => `${n} zł`;

/** Format a EUR amount: amount then unit — "22 €". */
export const eur = (n: number): string => `${n} €`;

/** Format a GBP amount: symbol then unit — "£22". */
export const gbp = (n: number): string => `£${n}`;

/** Resolve locale to its price formatter and ISO currency code. */
export function localeFormatter(locale: string): { fmt: (n: number) => string; currency: 'PLN' | 'GBP' | 'EUR' } {
  if (locale === 'pl') return { fmt: pln, currency: 'PLN' };
  if (locale === 'gb') return { fmt: gbp, currency: 'GBP' };
  return { fmt: eur, currency: 'EUR' };
}
