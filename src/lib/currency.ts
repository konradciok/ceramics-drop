/**
 * Display currency — decoupled from locale.
 *
 * The storefront has four locales (`pl`, `en`, `es`, `de`) but sells in several
 * currencies. `pl` always prices in PLN; every other locale defaults to EUR and
 * can be switched to another currency via the `currency_pref` cookie (set from
 * the visitor's `CF-IPCountry` on first request, overridable by the header
 * switcher). EUR is the default, GBP is live; USD/CAD are architected here but
 * not yet exposed in the UI (their price tables in `pricing.ts` are still null).
 *
 * This module is client-safe (no `next/headers`); the server-only cookie reader
 * `getCurrency` lives in `currency.server.ts`.
 */

export type Currency = 'pln' | 'eur' | 'gbp' | 'usd' | 'cad';

/** Cookie that stores the visitor's chosen display currency (max-age 1 year). */
export const CURRENCY_COOKIE = 'currency_pref';
export const CURRENCY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/** Currency used for any non-PL locale when no cookie / country signal exists. */
export const DEFAULT_CURRENCY: Currency = 'eur';

/**
 * Currencies offered in the header switcher today. USD/CAD are valid `Currency`
 * values (so checkout/pricing are already wired) but stay hidden until their
 * price tables are filled in and a country→currency mapping is added below.
 */
export const SWITCHABLE_CURRENCIES: readonly Currency[] = ['eur', 'gbp'];

/** Cloudflare `CF-IPCountry` → display currency. Extend to unlock a new market. */
const COUNTRY_CURRENCY: Record<string, Currency> = {
  GB: 'gbp',
  // US: 'usd',
  // CA: 'cad',
};

const VALID_CURRENCIES: ReadonlySet<Currency> = new Set<Currency>([
  'pln',
  'eur',
  'gbp',
  'usd',
  'cad',
]);

/** Narrow an untrusted string (cookie value, query param) to a `Currency`. */
export function parseCurrency(value: string | null | undefined): Currency | null {
  return value && VALID_CURRENCIES.has(value as Currency) ? (value as Currency) : null;
}

/**
 * Map a `CF-IPCountry` header value to a display currency. Anything we don't
 * explicitly sell in another currency (including the sentinel `XX`/`T1`) → EUR.
 */
export function currencyForCountry(country: string | null | undefined): Currency {
  if (!country) return DEFAULT_CURRENCY;
  return COUNTRY_CURRENCY[country.toUpperCase()] ?? DEFAULT_CURRENCY;
}

/**
 * The currency a locale defaults to with no cookie present. Used by SEO/feed
 * surfaces (structured data, product feeds) that must stay deterministic and
 * cookie-independent — search engines and feed crawlers never send the cookie.
 */
export function defaultCurrencyForLocale(locale: string): Currency {
  return locale === 'pl' ? 'pln' : DEFAULT_CURRENCY;
}

/**
 * Resolve the display currency from a raw `Cookie` header string. `pl` → PLN,
 * else the `currency_pref` cookie value → EUR default. Used both by the
 * server-only `getCurrency` (via `next/headers`) and by API route handlers that
 * already hold the `Request` and don't want the async request scope.
 */
export function currencyFromCookieHeader(
  locale: string,
  cookieHeader: string | null | undefined,
): Currency {
  if (locale === 'pl') return 'pln';
  const match = (cookieHeader ?? '').match(
    new RegExp(`(?:^|;\\s*)${CURRENCY_COOKIE}=([^;]+)`),
  );
  return parseCurrency(match?.[1]) ?? DEFAULT_CURRENCY;
}
