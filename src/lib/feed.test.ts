import { describe, it, expect, vi } from 'vitest';

// Deterministic CMS-collection name resolution for print feed titles — only
// the DB-facing loadPrintCollectionDefinitions call is mocked (same pattern
// as invoice.test.ts / cart-lines-server.test.ts), so buildFeedItems never
// makes a real Supabase call to resolve print collection names.
vi.mock('./print-collections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./print-collections')>();
  return {
    ...actual,
    // Name deliberately NOT 'Ostrea' — the static PRINT_COLLECTION_DEFINITIONS
    // default also names fap001's collection 'Ostrea', so asserting on that
    // name wouldn't prove this mocked `definitions` value was actually used
    // versus the static fallback silently winning (see the print-title
    // assertion below, which pins on 'CmsOnly 01').
    loadPrintCollectionDefinitions: vi.fn(async () => [
      { slug: 'ostrea', name: 'CmsOnly', designIds: ['fap001'], prints: [] },
    ]),
  };
});

import { buildFeedItems, buildGoogleXml, buildMetaXml, type FeedItem } from './feed';
import { getPrintDesigns } from './prints';
import { registryProducts } from './products';

const sampleItem: FeedItem = {
  id: 'fap999',
  title: 'Ostrea & Co #1',
  description: 'A <fine> print "with" special & chars.',
  link: 'https://anna-ciok.studio/en/fine-art-prints/fap999',
  imageLink: 'https://anna-ciok.studio/uploads/print.webp',
  additionalImages: ['https://anna-ciok.studio/uploads/print-2.webp'],
  availability: 'in stock',
  price: '25.00 EUR',
  category: 'fine-art-prints',
  material: 'Fine Art Print',
  productType: 'Prints > Print',
  customLabel0: 'standard',
  customLabel1: 'prints',
  customLabel2: 'fine-art-prints',
  shipping: [{ country: 'IE', service: 'Prodigi', price: '8.00 EUR' }],
};

describe('buildFeedItems — fine-art prints only', () => {
  it('emits exactly one row per published print design, matching the emitted content_ids', async () => {
    const items = await buildFeedItems('en');
    const feedIds = items.map((i) => i.id).sort();
    const designIds = (await getPrintDesigns()).map((d) => d.id).sort();
    expect(designIds).toContain('fap005'); // guard: registry actually has published prints
    expect(feedIds).toEqual(designIds); // exact set — withdrawn designs must not leak
  });

  it('carries no ceramic product whatsoever, in any locale', async () => {
    // Cross-checked against the live ceramic registry rather than a hardcoded
    // id list, so the guard cannot rot as the catalogue is cut or renumbered.
    const ceramicIds = new Set(registryProducts().map((p) => p.id));
    expect(ceramicIds.size).toBeGreaterThan(100); // guard: registry actually loaded

    for (const locale of ['pl', 'en', 'es', 'de'] as const) {
      const items = await buildFeedItems(locale);
      expect(items.length).toBeGreaterThan(0);
      expect(items.filter((i) => ceramicIds.has(i.id))).toEqual([]);
      expect(items.every((i) => i.category === 'fine-art-prints')).toBe(true);
      expect(items.every((i) => /^fap\d{3}$/.test(i.id))).toBe(true);
    }
  });

  it('prices prints from print-pricing "from" price in the locale currency, always in stock', async () => {
    const pl = (await buildFeedItems('pl')).find((i) => i.id === 'fap005');
    const en = (await buildFeedItems('en')).find((i) => i.id === 'fap005');
    // fap005 cheapest size (30x40) = 105 PLN / 22 GBP (print-pricing SIZE_BASE
    // 25 EUR, derived per DEFAULT_PRINT_PRICING.eurToGbp = 0.86).
    expect(pl?.price).toBe('105.00 PLN');
    expect(en?.price).toBe('22.00 GBP');
    expect(pl?.availability).toBe('in stock'); // print-on-demand — never sold out
    expect(pl?.shipping.length).toBeGreaterThan(0);
  });

  it('quotes the display currency per locale: pl → PLN, en → GBP, es/de → EUR', async () => {
    const pl = await buildFeedItems('pl');
    expect(pl.every((i) => i.price.endsWith(' PLN'))).toBe(true);

    const en = await buildFeedItems('en');
    expect(en.length).toBeGreaterThan(0);
    expect(en.every((i) => i.price.endsWith(' GBP'))).toBe(true);

    for (const locale of ['es', 'de'] as const) {
      const items = await buildFeedItems(locale);
      expect(items.every((i) => i.price.endsWith(' EUR'))).toBe(true);
    }
  });

  it('ships the en feed to GB, on the Prodigi GB rate quoted in GBP', async () => {
    const items = await buildFeedItems('en');
    expect(items.length).toBeGreaterThan(0);
    items.forEach((item) => {
      expect(item.shipping).toEqual([
        { country: 'GB', service: 'Prodigi', price: expect.stringMatching(/^\d+\.00 GBP$/) },
      ]);
    });
  });

  it('titles a fine-art print with the CMS-resolved collection name (proves `definitions` is threaded through, not dropped)', async () => {
    const items = await buildFeedItems('en');
    expect(items.find((i) => i.id === 'fap001')?.title).toBe('CmsOnly 01');
  });
});

describe('buildGoogleXml', () => {
  it('escapes XML special characters in title and description', () => {
    const xml = buildGoogleXml([sampleItem], 'en');
    expect(xml).toContain('Ostrea &amp; Co #1');
    expect(xml).toContain('&lt;fine&gt;');
    expect(xml).toContain('&amp; chars');
    expect(xml).toContain('&quot;with&quot;');
  });

  it('includes g:identifier_exists=no (no GTIN for studio prints)', () => {
    expect(buildGoogleXml([sampleItem], 'en')).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });

  it('declares the Fine Art Prints google_product_category and no ceramic taxonomy', () => {
    const xml = buildGoogleXml([sampleItem], 'en');
    expect(xml).toContain(
      '<g:google_product_category>Arts &amp; Entertainment &gt; Fine Art &gt; Prints</g:google_product_category>',
    );
    expect(xml).not.toContain('Tableware');
    expect(xml).not.toContain('Vases');
  });

  it('includes g:shipping with the per-locale Prodigi rate', () => {
    const xml = buildGoogleXml([sampleItem], 'en');
    expect(xml).toContain('<g:country>IE</g:country>');
    expect(xml).toContain('<g:service>Prodigi</g:service>');
  });

  it('ships the real en feed to GB, matching its GBP pricing', async () => {
    const items = await buildFeedItems('en');
    const xml = buildGoogleXml(items, 'en');
    expect(xml).toContain('<g:country>GB</g:country>');
    expect(xml).not.toContain('<g:country>IE</g:country>');
    expect(xml).toContain('.00 GBP</g:price>');
  });

  it('renders a real print g:id and no ceramic ids', async () => {
    const items = await buildFeedItems('en');
    const xml = buildGoogleXml(items, 'en');
    expect(xml).toContain('<g:id>fap005</g:id>');
    for (const id of registryProducts().slice(0, 20).map((p) => p.id)) {
      expect(xml).not.toContain(`<g:id>${id}</g:id>`);
    }
  });
});

describe('buildMetaXml', () => {
  it('includes g:identifier_exists=no (no GTIN for studio prints)', () => {
    expect(buildMetaXml([sampleItem], 'en')).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });

  it('includes g:additional_image_link for gallery images', () => {
    expect(buildMetaXml([sampleItem], 'en')).toContain(
      '<g:additional_image_link>https://anna-ciok.studio/uploads/print-2.webp</g:additional_image_link>',
    );
  });

  it('declares the Fine Art Prints google_product_category', () => {
    expect(buildMetaXml([sampleItem], 'en')).toContain(
      '<g:google_product_category>Arts &amp; Entertainment &gt; Fine Art &gt; Prints</g:google_product_category>',
    );
  });

  it('renders a real print g:id and no ceramic ids', async () => {
    const items = await buildFeedItems('en');
    const xml = buildMetaXml(items, 'en');
    expect(xml).toContain('<g:id>fap005</g:id>');
    for (const id of registryProducts().slice(0, 20).map((p) => p.id)) {
      expect(xml).not.toContain(`<g:id>${id}</g:id>`);
    }
  });
});
