/** Canonical production origin (apex). Prefer www redirect in Cloudflare if apex DNS is still propagating. */
export const SITE_URL = 'https://anna-ciok.studio';

/** Workshop booking site — a separate app (konradciok/workshops) on its own subdomain. */
export const WORKSHOPS_URL = 'https://workshops.anna-ciok.studio';

/** The workshops site in the same language: it uses the shop's locale scheme (PL unprefixed). */
export function workshopsUrl(locale: string): string {
  return locale === 'pl' ? WORKSHOPS_URL : `${WORKSHOPS_URL}/${locale}`;
}

/**
 * Fine-art print shop — prints moved off this storefront to a separate Shopify
 * store (2026-11). Every former print URL here 301s there (see
 * `print-shop-redirects.ts`); nav/footer link out to it.
 */
export const PRINT_SHOP_URL = 'https://anna-ciok.com';

/**
 * The print shop in the same language. Its locale scheme is Shopify's, NOT
 * ours: English is the unprefixed primary and Polish lives under `/pl`.
 * `path` must start with `/` (e.g. `/products/<handle>`); '' is the home page.
 */
export function printShopUrl(locale: string, path = ''): string {
  const prefix = locale === 'en' ? '' : `/${locale}`;
  return `${PRINT_SHOP_URL}${prefix}${path}` || PRINT_SHOP_URL;
}

/** Brand name — a proper noun, identical across locales. Single source for metadata + JSON-LD. */
export const SITE_NAME = 'Anna Ciok Studio';
export const ARTIST_NAME = 'Anna Ciok';

export const STUDIO = {
  name: SITE_NAME,
  artist: ARTIST_NAME,
  taxId: 'Y9608071L',
  address: {
    streetAddress: 'San Pedro Abajo 12',
    postalCode: '38500',
    addressLocality: 'Guimar',
    addressRegion: 'Tenerife, Canarias',
    addressCountry: 'ES',
  },
  instagram: 'https://www.instagram.com/anna.ciok.art/',
  facebook: 'https://www.facebook.com/anki.doodle.tenerife/',
} as const;

/**
 * Merchant brand, shared with the storefront; the artist is ARTIST_NAME.
 * Shared by the Google/Meta feed (`<g:brand>`, feed.ts) and the on-page
 * `Product.brand` JSON-LD (structured-data.ts) so they never disagree.
 */
export const PRODUCT_BRAND_NAME = SITE_NAME;

/** App routes under `[locale]` (path segment only, leading slash).
 *
 *  The collection routes list all visible families. This is kept static (not
 *  derived from VISIBLE_CATEGORY_ORDER) so `site.ts` stays a dependency-free
 *  leaf; a test in `site.test.ts` enforces it never drifts from the product
 *  registry. */
export const SITE_PATHS = [
  '/',
  '/sklep',
  '/showroom',
  '/gallery',
  '/kubki',
  '/wazony',
  '/talerzyki',
  '/talerze-male',
  '/talerze-srednie',
  '/talerze-duze',
  '/talerze-owalne',
  '/koszyk',
  '/karta-podarunkowa',
  '/o-studiu',
  '/kontakt',
  '/regulamin',
  '/polityka-prywatnosci',
  '/dostawa-i-zwroty',
  '/refund-policy',
] as const;

/**
 * Routes that should not be indexed — cart/checkout surfaces are session-specific
 * and often empty. Excluded from the sitemap and marked `robots: noindex` per page.
 * `/koszyk/return` isn't in `SITE_PATHS` (never sitemapped), but is listed here
 * too for documentation parity with its own `noindex` layout.
 */
export const NOINDEX_PATHS: readonly string[] = ['/koszyk', '/koszyk/return', '/koszyk/potwierdzenie'];
