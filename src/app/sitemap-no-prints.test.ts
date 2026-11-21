import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routing } from '@/i18n/routing';
import { absoluteUrl } from '@/lib/seo/urls';
import sitemap from './sitemap';

// Fine-art prints moved to their own shop (PRINT_SHOP_URL); every former print
// URL 301s there, so none may be advertised to crawlers from this site.
describe('sitemap: no fine-art-print URLs', () => {
  const previous = process.env.CATALOG_SOURCE;
  beforeAll(() => {
    process.env.CATALOG_SOURCE = 'code';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = previous;
  });

  it('lists no print PDP and no /kolekcje page', async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.filter((u) => /\/fine-art-prints(\/|$)|\/kolekcje(\/|$)/.test(u))).toEqual([]);
  });

  it('still lists the ceramics shop in every locale', async () => {
    const urls = new Set((await sitemap()).map((e) => e.url));
    for (const locale of routing.locales) expect(urls.has(absoluteUrl(locale, '/sklep'))).toBe(true);
  });
});
