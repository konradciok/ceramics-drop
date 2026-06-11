import type { Metadata } from 'next';
import { routing, type Locale } from '@/i18n/routing';
import { localePath } from '@/lib/locale-path';
import { SITE_URL } from '@/lib/site';

/**
 * Absolute, locale-aware URL for an app route (e.g. `https://anna-ciok.studio/kubki`,
 * `https://anna-ciok.studio/en/kubki`). The home path collapses to the bare origin
 * (no trailing slash) so canonicals and sitemap entries agree.
 */
export function absoluteUrl(locale: Locale, path: string): string {
  const pathname = localePath(locale, path);
  return pathname === '/' ? SITE_URL : `${SITE_URL}${pathname}`;
}

/**
 * hreflang map for a route: one absolute URL per locale plus `x-default`
 * (the default locale). Shared by page `<head>` alternates and the sitemap so
 * the two never drift apart.
 */
export function languageAlternates(path: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const l of routing.locales) {
    languages[l] = absoluteUrl(l, path);
  }
  languages['x-default'] = absoluteUrl(routing.defaultLocale, path);
  return languages;
}

/**
 * Canonical + hreflang alternates for a route, ready to spread into a page's
 * `metadata.alternates`. Emits one `hreflang` per locale plus `x-default` so all
 * three language variants cross-reference each other in `<head>`.
 */
export function alternatesFor(locale: Locale, path: string): Metadata['alternates'] {
  return {
    canonical: absoluteUrl(locale, path),
    languages: languageAlternates(path),
  };
}

/** Canonical + hreflang alternates for an individual product page. */
export function productAlternates(locale: Locale, slug: string, id: string): Metadata['alternates'] {
  return alternatesFor(locale, `/${slug}/${id}`);
}
