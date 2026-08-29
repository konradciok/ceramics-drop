import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routing } from '@/i18n/routing';
import { absoluteUrl, languageAlternates } from '@/lib/seo/urls';
import sitemap from './sitemap';

describe('runtime sitemap SEO', () => {
  const previousCatalogSource = process.env.CATALOG_SOURCE;

  beforeAll(() => {
    process.env.CATALOG_SOURCE = 'code';
  });

  afterAll(() => {
    if (previousCatalogSource === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = previousCatalogSource;
  });

  it('preserves locale alternates without emitting a request-time lastmod', async () => {
    const entries = await sitemap();
    const homeEntries = routing.locales.map((locale) =>
      entries.find((entry) => entry.url === absoluteUrl(locale, '/')),
    );

    expect(homeEntries.every(Boolean)).toBe(true);
    expect(homeEntries[0]?.alternates?.languages).toEqual(languageAlternates('/'));
    expect(entries.every((entry) => entry.lastModified === undefined)).toBe(true);
  });
});
