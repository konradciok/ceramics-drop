import { cookies } from 'next/headers';
import {
  CURRENCY_COOKIE,
  DEFAULT_CURRENCY,
  parseCurrency,
  type Currency,
} from './currency';

/**
 * Server-side display currency for the current request. `pl` forces PLN; any
 * other locale reads the `currency_pref` cookie and falls back to EUR. Reading
 * the cookie opts the caller into dynamic rendering — pair with `Vary: Cookie`
 * (set in middleware) so cached responses aren't shared across currencies.
 *
 * Lives apart from `currency.ts` (which is client-safe) so importing the shared
 * currency helpers into a client component never pulls in `next/headers`.
 */
export async function getCurrency(locale: string): Promise<Currency> {
  if (locale === 'pl') return 'pln';
  const store = await cookies();
  return parseCurrency(store.get(CURRENCY_COOKIE)?.value) ?? DEFAULT_CURRENCY;
}
