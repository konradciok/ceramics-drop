import { describe, it, expect } from 'vitest';
import { collectionSchema, organizationSchema } from './structured-data';
import { getProductsByCategory } from '@/lib/products';
import { SITE_URL } from '@/lib/site';

/** Stub translator: returns the key so assertions are locale-agnostic. */
const t = (key: string) => key;

/**
 * schema-dts types are deliberately strict unions that can't be index-accessed
 * directly; in tests we treat the emitted schema as the plain JSON it serialises to.
 */
type Offer = { priceCurrency: string; availability: string };
type Node = {
  '@type': string;
  numberOfItems?: number;
  itemListElement?: { item: { image: string; offers: Offer } }[];
};

describe('organizationSchema', () => {
  it('describes the brand with an absolute logo URL', () => {
    const org = organizationSchema() as unknown as Record<string, unknown>;
    expect(org['@type']).toBe('Organization');
    expect(org.url).toBe(SITE_URL);
    expect(org.logo).toBe(`${SITE_URL}/logotype.png`);
  });
});

describe('collectionSchema', () => {
  const graph = collectionSchema({ slug: 'kubki', locale: 'pl', t });
  const nodes = graph['@graph'] as unknown as Node[];

  it('contains a BreadcrumbList and an ItemList', () => {
    expect(nodes.map((n) => n['@type'])).toEqual(['BreadcrumbList', 'ItemList']);
  });

  it('lists every piece in the family as a Product', () => {
    const expected = getProductsByCategory('kubki').length;
    expect(nodes[1].numberOfItems).toBe(expected);
    expect(nodes[1].itemListElement).toHaveLength(expected);
  });

  it('prices every offer in PLN, in stock by default, with an absolute image URL', () => {
    for (const { item } of nodes[1].itemListElement ?? []) {
      expect(item.offers.priceCurrency).toBe('PLN');
      expect(item.offers.availability).toBe('https://schema.org/InStock');
      expect(item.image.startsWith(`${SITE_URL}/`)).toBe(true);
    }
  });

  it('maps live soldIds to SoldOut, leaving the rest InStock', () => {
    const products = getProductsByCategory('kubki');
    const soldId = products[0].id; // first piece, e.g. "k01"
    const soldGraph = collectionSchema({ slug: 'kubki', locale: 'pl', t, soldIds: [soldId] });
    const items = (soldGraph['@graph'][1] as unknown as Node).itemListElement ?? [];

    expect(items[0].item.offers.availability).toBe('https://schema.org/SoldOut');
    for (const { item } of items.slice(1)) {
      expect(item.offers.availability).toBe('https://schema.org/InStock');
    }
  });
});
