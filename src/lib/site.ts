/** Canonical production origin (apex). Prefer www redirect in Cloudflare if apex DNS is still propagating. */
export const SITE_URL = 'https://anna-ciok.studio';

/** App routes under `[locale]` (path segment only, leading slash). */
export const SITE_PATHS = [
  '/',
  '/kubki',
  '/duze-michy',
  '/miski-falowane',
  '/talerze-duze',
  '/talerzyki',
  '/wazony',
  '/wazony-duze',
  '/koszyk',
  '/o-studiu',
  '/kontakt',
  '/regulamin',
  '/polityka-prywatnosci',
  '/dostawa-i-zwroty',
] as const;
