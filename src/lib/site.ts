/** Canonical production origin (apex). Prefer www redirect in Cloudflare if apex DNS is still propagating. */
export const SITE_URL = 'https://anna-ciok.studio';

/** Brand name — a proper noun, identical across locales. Single source for metadata + JSON-LD. */
export const SITE_NAME = 'Anna Ciok Ceramics';

/** App routes under `[locale]` (path segment only, leading slash). */
export const SITE_PATHS = [
  '/',
  '/sklep',
  '/kubki',
  '/duze-michy',
  '/miski-falowane',
  '/talerze-duze',
  '/talerzyki',
  '/talerze-srednie',
  '/wazony',
  '/wazony-srednie',
  '/wazony-duze',
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
 */
export const NOINDEX_PATHS: readonly string[] = ['/koszyk'];
