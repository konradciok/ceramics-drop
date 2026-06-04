import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { absoluteUrl } from '@/lib/seo/urls';
import { SITE_PATHS } from '@/lib/site';

/** Stable per-build timestamp — avoids churning every entry's lastmod on each request. */
const LAST_MODIFIED = new Date();

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];

  for (const path of SITE_PATHS) {
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, path),
        lastModified: LAST_MODIFIED,
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
