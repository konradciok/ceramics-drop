import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { absoluteUrl, languageAlternates } from '@/lib/seo/urls';
import { NOINDEX_PATHS, SITE_PATHS } from '@/lib/site';
import { getPublicProducts } from '@/lib/products';
import { getPrintDesigns } from '@/lib/prints';

// Product visibility is database-owned in production. Generate the sitemap on
// request so archived/activated catalog rows are reflected without a rebuild.
// Omit lastModified until each source exposes a truthful change timestamp;
// request/isolate time would falsely report that every URL changed together.
export const dynamic = 'force-dynamic';

/** Generates all site URLs for search-engine crawlers: category pages + individual product pages (ceramics + fine-art prints) across all locales. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [];
  const paths = SITE_PATHS.filter((path) => !NOINDEX_PATHS.includes(path));

  for (const path of paths) {
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, path),
        alternates: { languages: languageAlternates(path) },
      });
    }
  }

  for (const product of await getPublicProducts()) {
    const path = `/${product.category}/${product.id}`;
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, path),
        alternates: { languages: languageAlternates(path) },
      });
    }
  }

  for (const design of await getPrintDesigns()) {
    const path = `/${design.category}/${design.id}`;
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, path),
        alternates: { languages: languageAlternates(path) },
      });
    }
  }

  return entries;
}
