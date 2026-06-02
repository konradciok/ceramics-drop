import type { MetadataRoute } from 'next';
import { routing, type Locale } from '@/i18n/routing';
import { localePath } from '@/lib/locale-path';
import { SITE_PATHS, SITE_URL } from '@/lib/site';

function absoluteUrl(locale: Locale, path: string): string {
  const pathname = localePath(locale, path);
  return pathname === '/' ? SITE_URL : `${SITE_URL}${pathname}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];

  for (const path of SITE_PATHS) {
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, path),
        lastModified: new Date(),
        alternates: {
          languages: Object.fromEntries(
            routing.locales.map((l) => [l, absoluteUrl(l, path)]),
          ),
        },
      });
    }
  }

  return entries;
}
