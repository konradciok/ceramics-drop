import { routing, type Locale } from '@/i18n/routing';

/** Public URL path for a locale + app route (e.g. `/kubki`, `/en/kubki`). */
export function localePath(locale: Locale, path: string): string {
  const normalized = path === '/' ? '' : path;
  if (locale === routing.defaultLocale) {
    return normalized || '/';
  }
  return `/${locale}${normalized}`;
}
