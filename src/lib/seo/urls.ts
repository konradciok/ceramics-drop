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
 * the two never drift apart. Every locale slug is a valid BCP47 language tag,
 * so it doubles as its own hreflang.
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

/**
 * hreflang map restricted to `locales` — the ones in which a page is actually
 * indexable — or undefined when fewer than two remain (a lone locale has no
 * alternates to declare). `x-default` prefers the default locale and otherwise
 * falls back to the first listed one, so it never points at a noindex page.
 * Shared by the page `<head>` and the sitemap so the two stay in step.
 */
export function languageAlternatesFor(path: string, locales: readonly Locale[]): Record<string, string> | undefined {
  if (locales.length < 2) return undefined;
  const languages: Record<string, string> = {};
  for (const l of locales) languages[l] = absoluteUrl(l, path);
  const fallback = locales.includes(routing.defaultLocale) ? routing.defaultLocale : locales[0];
  languages['x-default'] = absoluteUrl(fallback, path);
  return languages;
}

/**
 * Canonical + hreflang for a page that is indexable only in some locales (e.g.
 * a collection with real copy in pl but a placeholder in en). The canonical is
 * always the page's own URL; hreflang lists ONLY the indexable locales —
 * alternates pointing at noindex pages make an inconsistent cluster — and is
 * omitted when the current locale is itself not indexable.
 */
export function alternatesForIndexableLocales(
  locale: Locale,
  path: string,
  indexable: readonly Locale[],
): Metadata['alternates'] {
  const languages = indexable.includes(locale) ? languageAlternatesFor(path, indexable) : undefined;
  return { canonical: absoluteUrl(locale, path), ...(languages && { languages }) };
}

/** Canonical + hreflang alternates for an individual product page. */
export function productAlternates(locale: Locale, slug: string, id: string): Metadata['alternates'] {
  return alternatesFor(locale, `/${slug}/${id}`);
}
