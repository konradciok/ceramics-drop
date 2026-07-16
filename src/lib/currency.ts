/**
 * Display currency — decoupled from locale.
 *
 * The storefront has four locales (`pl`, `en`, `es`, `de`) but sells in several
 * currencies. `pl` always prices in PLN; every other locale defaults to EUR and
 * can be switched to another currency via the `currency_pref` cookie (set from
 * the visitor's `CF-IPCountry` on first request, overridable by the header
 * switcher). EUR is the default, GBP is live.
 *
 * This module is client-safe (no `next/headers`); the server-only cookie reader
 * `getCurrency` lives in `currency.server.ts`.
 */

export type Currency = 'pln' | 'eur' | 'gbp';

/** Cookie that stores the visitor's chosen display currency (max-age 1 year). */
export const CURRENCY_COOKIE = 'currency_pref';
export const CURRENCY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/** Currency used for any non-PL locale when no cookie / country signal exists. */
export const DEFAULT_CURRENCY: Currency = 'eur';

/**
 * Currencies offered in the header switcher today.
 */
export const SWITCHABLE_CURRENCIES: readonly Currency[] = ['eur', 'gbp'];

/** Cloudflare `CF-IPCountry` → display currency. Extend to unlock a new market. */
const COUNTRY_CURRENCY: Record<string, Currency> = {
  GB: 'gbp',
};

const VALID_CURRENCIES: ReadonlySet<Currency> = new Set<Currency>([
  'pln',
  'eur',
  'gbp',
]);

/** Narrow an untrusted string (cookie value, query param) to a `Currency`. */
export function parseCurrency(value: string | null | undefined): Currency | null {
  return value && VALID_CURRENCIES.has(value as Currency) ? (value as Currency) : null;
}

/**
 * Currencies the storefront can actually price and charge today.
 */
export const SELLABLE_CURRENCIES: readonly Currency[] = ['pln', 'eur', 'gbp'];

/**
 * Clamp any currency to one we can charge in Stripe today (`pln`/`eur`/`gbp`),
 * mapping anything unrecognised to EUR. Shared by checkout and the cart/print
 * price paths so the mapping lives in exactly one place.
 */
export function toChargeableCurrency(currency: Currency): 'pln' | 'eur' | 'gbp' {
  return currency === 'gbp' ? 'gbp' : currency === 'pln' ? 'pln' : 'eur';
}

/**
 * Resolve a non-PL display currency from a raw cookie value, clamped to the
 * currencies the UI can actually switch to (EUR/GBP). A tampered or stale cookie
 * (`pln`, garbage, or any future value not yet switched on) falls back to EUR so
 * `priceOfCurrency` is never handed a currency it can't price.
 */
function displayCurrencyFromCookieValue(value: string | null | undefined): Currency {
  const parsed = parseCurrency(value);
  return parsed && SWITCHABLE_CURRENCIES.includes(parsed) ? parsed : DEFAULT_CURRENCY;
}

/** Read the `currency_pref` value out of a raw `Cookie` header string. */
export function readCurrencyCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === CURRENCY_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Server-side clamp of a parsed cookie value to a switchable display currency.
 * Shared by `getCurrency` (currency.server.ts) and `currencyFromCookieHeader`.
 */
export function displayCurrencyFor(locale: string, cookieValue: string | null | undefined): Currency {
  if (locale === 'pl') return 'pln';
  return displayCurrencyFromCookieValue(cookieValue);
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
 * else the `currency_pref` cookie value clamped to a switchable currency
 * (EUR/GBP), defaulting to EUR. Used both by the server-only `getCurrency` (via
 * `next/headers`) and by API route handlers that already hold the `Request`.
 */
export function currencyFromCookieHeader(
  locale: string,
  cookieHeader: string | null | undefined,
): Currency {
  return displayCurrencyFor(locale, readCurrencyCookie(cookieHeader));
}
