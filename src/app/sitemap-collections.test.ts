import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routing } from '@/i18n/routing';
import { absoluteUrl } from '@/lib/seo/urls';
import type { PrintCollectionDefinition } from '@/lib/print-curation';

// linea (9 prints) has real pl copy only; cirrus (1 print) has copy in every locale but is thin.
vi.mock('@/lib/print-collections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/print-collections')>();
  const COPY = 'x'.repeat(120);
  const definitions: PrintCollectionDefinition[] = actual.PRINT_COLLECTIONS.map((c) => {
    if (c.slug === 'linea') return { ...c, descriptions: { pl: COPY, en: 'Linea.' } };
    if (c.slug === 'cirrus') return { ...c, descriptions: { pl: COPY, en: COPY, es: COPY, de: COPY } };
    return c;
  });
  return { ...actual, loadPrintCollectionDefinitions: async () => definitions };
});

import sitemap from './sitemap';

describe('sitemap: print collection pages', () => {
  const previous = process.env.CATALOG_SOURCE;
  beforeAll(() => {
    process.env.CATALOG_SOURCE = 'code';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = previous;
  });

  it('always lists the /kolekcje hub in every locale', async () => {
    const urls = new Set((await sitemap()).map((e) => e.url));
    for (const locale of routing.locales) expect(urls.has(absoluteUrl(locale, '/kolekcje'))).toBe(true);
  });

  it('lists a collection page only in locales where it has real copy and enough prints', async () => {
    const urls = new Set((await sitemap()).map((e) => e.url));
    expect(urls.has(absoluteUrl('pl', '/kolekcje/linea'))).toBe(true);
    // en carries only the seeded "<name>." placeholder → noindex → not in the sitemap.
    expect(urls.has(absoluteUrl('en', '/kolekcje/linea'))).toBe(false);
    expect(urls.has(absoluteUrl('es', '/kolekcje/linea'))).toBe(false);
  });

  it('keeps thin collections (fewer than 3 prints) out even with copy', async () => {
    const urls = [...(await sitemap()).map((e) => e.url)];
    expect(urls.some((u) => u.includes('/kolekcje/cirrus'))).toBe(false);
  });
});
