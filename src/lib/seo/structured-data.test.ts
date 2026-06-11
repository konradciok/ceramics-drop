import { describe, it, expect } from 'vitest';
import { collectionSchema, organizationSchema, productSchema } from './structured-data';
import { getProductsByCategory } from '@/lib/products';
import { SITE_URL } from '@/lib/site';
import { EMAIL } from '@/lib/email-addresses';

/** Stub translator: returns the key so assertions are locale-agnostic. */
const t = (key: string) => key;

/**
 * schema-dts types are deliberately strict unions that can't be index-accessed
 * directly; in tests we treat the emitted schema as the plain JSON it serialises to.
 */
type Offer = { priceCurrency: string; availability: string; url: string };
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

  it('exposes the public contact email from the shared address module', () => {
    const org = organizationSchema() as unknown as Record<string, unknown>;
    expect(org.email).toBe(EMAIL.contact);
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

  it('prices every offer in PLN and maps availability from catalog sold flags', () => {
    const products = getProductsByCategory('kubki');
    (nodes[1].itemListElement ?? []).forEach(({ item }, i) => {
      const expected = products[i].sold
        ? 'https://schema.org/SoldOut'
        : 'https://schema.org/InStock';
      expect(item.offers.priceCurrency).toBe('PLN');
      expect(item.offers.availability).toBe(expected);
      expect(item.offers.url).toBe(`${SITE_URL}/kubki/${products[i].id}`);
      expect(item.image.startsWith(`${SITE_URL}/`)).toBe(true);
    });
  });

  it('maps live soldIds to SoldOut, leaving the rest at their catalog state', () => {
    const products = getProductsByCategory('kubki');
    const soldId = products[0].id; // first piece, e.g. "k01"
    const soldGraph = collectionSchema({ slug: 'kubki', locale: 'pl', t, soldIds: [soldId] });
    const items = (soldGraph['@graph'][1] as unknown as Node).itemListElement ?? [];

    items.forEach(({ item }, i) => {
      const expected =
        products[i].sold || products[i].id === soldId
          ? 'https://schema.org/SoldOut'
          : 'https://schema.org/InStock';
      expect(item.offers.availability).toBe(expected);
    });
  });
});

describe('productSchema', () => {
  const products = getProductsByCategory('kubki');
  const product = { ...products[0], sold: false };
  const tRaw = (key: string) => {
    // Return a stub notes array so noteIndex lookup works
    if (key.startsWith('notes.')) return ['test note'];
    return key;
  };
  const graph = productSchema({ product, locale: 'pl', t, tRaw });
  const nodes = graph['@graph'] as unknown as Record<string, unknown>[];

  it('contains a BreadcrumbList and a Product node', () => {
    expect(nodes.map((n) => n['@type'])).toEqual(['BreadcrumbList', 'Product']);
  });

  it('breadcrumb has three positions: site → category → product', () => {
    const crumbs = nodes[0]['itemListElement'] as { '@type': string; position: number; item: string }[];
    expect(crumbs).toHaveLength(3);
    expect(crumbs[0].position).toBe(1);
    expect(crumbs[1].position).toBe(2);
    expect(crumbs[2].position).toBe(3);
    expect(crumbs[2].item).toBe(`${SITE_URL}/kubki/${product.id}`);
  });

  it('product node has absolute image URLs and sku matching the product id', () => {
    const images = nodes[1]['image'] as string[];
    expect(Array.isArray(images)).toBe(true);
    images.forEach((img) => expect(img.startsWith(`${SITE_URL}/`)).toBe(true));
    expect(nodes[1]['sku']).toBe(product.id);
    expect(nodes[1]['@id']).toBe(`${SITE_URL}/kubki/${product.id}`);
  });

  it('offer url points at the locale-aware PDP URL', () => {
    const offer = nodes[1]['offers'] as { url: string; priceCurrency: string };
    expect(offer.url).toBe(`${SITE_URL}/kubki/${product.id}`);
    expect(offer.priceCurrency).toBe('PLN');
  });

  it('maps sold flag to SoldOut / InStock availability', () => {
    const availableOffer = (nodes[1]['offers'] as { availability: string });
    expect(availableOffer.availability).toBe('https://schema.org/InStock');

    const soldGraph = productSchema({ product: { ...product, sold: true }, locale: 'pl', t, tRaw });
    const soldOffer = (soldGraph['@graph'][1] as unknown as Record<string, { availability: string }>)['offers'];
    expect(soldOffer.availability).toBe('https://schema.org/SoldOut');
  });

  it('en locale uses /en/ prefix in URLs', () => {
    const enGraph = productSchema({ product, locale: 'en', t, tRaw });
    const enNodes = enGraph['@graph'] as unknown as Record<string, unknown>[];
    const enOffer = enNodes[1]['offers'] as { url: string };
    expect(enOffer.url).toBe(`${SITE_URL}/en/kubki/${product.id}`);
  });
});
