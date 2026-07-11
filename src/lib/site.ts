/** Canonical production origin (apex). Prefer www redirect in Cloudflare if apex DNS is still propagating. */
export const SITE_URL = 'https://anna-ciok.studio';

/** Brand name — a proper noun, identical across locales. Single source for metadata + JSON-LD. */
export const SITE_NAME = 'Anna Ciok Ceramics';

/**
 * Merchant `brand` value — deliberately the artist's name, not `SITE_NAME`.
 * Shared by the Google/Meta feed (`<g:brand>`, feed.ts) and the on-page
 * `Product.brand` JSON-LD (structured-data.ts) so they never disagree.
 */
export const PRODUCT_BRAND_NAME = 'Anna Ciok';

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
  '/fine-art-prints',
  '/gallery',
  '/kubki',
  '/wazony',
  '/wazony-srednie',
  '/wazony-duze',
  '/talerzyki',
  '/talerze-srednie',
  '/talerze-duze',
  '/duze-michy',
  '/miski-falowane',
  '/koszyk',
  '/o-studiu',
  '/kontakt',
  '/regulamin',
  '/polityka-prywatnosci',
  '/dostawa-i-zwroty',
] as const;

/**
 * Routes that should not be indexed — cart/checkout surfaces are session-specific
 * and often empty. Excluded from the sitemap and marked `robots: noindex` per page.
 * `/koszyk/return` isn't in `SITE_PATHS` (never sitemapped), but is listed here
 * too for documentation parity with its own `noindex` layout.
 */
export const NOINDEX_PATHS: readonly string[] = ['/koszyk', '/koszyk/return'];
