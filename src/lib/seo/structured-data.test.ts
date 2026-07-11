import { describe, it, expect, beforeAll } from 'vitest';
import { collectionSchema, organizationSchema, productSchema } from './structured-data';
import { registryProductsByCategory } from '@/lib/products';
import { PRICE_EUR } from '@/lib/pricing';
import { SITE_URL } from '@/lib/site';
import { EMAIL } from '@/lib/email-addresses';

/** Stub translator: returns the key so assertions are locale-agnostic. */
const t = (key: string) => key;

/**
 * schema-dts types are deliberately strict unions that can't be index-accessed
 * directly; in tests we treat the emitted schema as the plain JSON it serialises to.
 */
type Offer = {
  priceCurrency: string;
  availability: string;
  url: string;
  shippingDetails?: { shippingRate: { value: number; currency: string }; shippingDestination: { addressCountry: string } }[];
  hasMerchantReturnPolicy?: { merchantReturnDays: number; returnPolicyCategory: string };
};
type Node = {
  '@type': string;
  numberOfItems?: number;
  itemListElement?: { item: { image: string; description?: string; brand?: { name: string }; offers: Offer } }[];
};

/**
 * Stub raw-message accessor: for `notes.*` keys, returns an array-like proxy
 * that answers 'stub note' for any numeric index — real `noteIndex` values
 * aren't sequential from 0, so a plain short array would silently miss most items.
 */
const tRaw = (key: string): unknown => {
  if (!key.startsWith('notes.')) return key;
  return new Proxy([] as string[], {
    get: (target, prop) => (prop in target ? target[prop as keyof string[]] : 'stub note'),
  });
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
  let nodes: Node[];
  beforeAll(async () => {
    const graph = await collectionSchema({ slug: 'kubki', locale: 'pl', t, tRaw });
    nodes = graph['@graph'] as unknown as Node[];
  });

  it('contains a BreadcrumbList and an ItemList', () => {
    expect(nodes.map((n) => n['@type'])).toEqual(['BreadcrumbList', 'ItemList']);
  });

  it('lists every piece in the family as a Product', () => {
    const expected = registryProductsByCategory('kubki').length;
    expect(nodes[1].numberOfItems).toBe(expected);
    expect(nodes[1].itemListElement).toHaveLength(expected);
  });

  it('prices every offer in PLN and maps availability from catalog sold flags', () => {
    const products = registryProductsByCategory('kubki');
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

  it('sets brand on every item and a description from the tRaw notes fallback', () => {
    (nodes[1].itemListElement ?? []).forEach(({ item }) => {
      expect(item.brand).toEqual({ '@type': 'Brand', name: 'Anna Ciok' });
      expect(item.description).toBe('stub note');
    });
  });

  it('prefers a CMS-resolved note over the tRaw fallback when notes are provided', async () => {
    const products = registryProductsByCategory('kubki');
    const firstId = products[0].id;
    const cmsGraph = await collectionSchema({
      slug: 'kubki',
      locale: 'pl',
      t,
      tRaw,
      notes: { [firstId]: 'cms note' },
    });
    const cmsNodes = cmsGraph['@graph'] as unknown as Node[];
    const items = cmsNodes[1].itemListElement ?? [];
    expect(items[0].item.description).toBe('cms note');
    expect(items[1].item.description).toBe('stub note');
  });

  it('attaches ceramics shippingDetails and a 14-day hasMerchantReturnPolicy to every offer', () => {
    (nodes[1].itemListElement ?? []).forEach(({ item }) => {
      expect(item.offers.shippingDetails).toHaveLength(2);
      item.offers.shippingDetails?.forEach((rate) => {
        expect(rate.shippingRate.currency).toBe('PLN');
        expect(rate.shippingDestination.addressCountry).toBe('PL');
      });
      expect(item.offers.hasMerchantReturnPolicy?.merchantReturnDays).toBe(14);
      expect(item.offers.hasMerchantReturnPolicy?.returnPolicyCategory).toBe(
        'https://schema.org/MerchantReturnFiniteReturnWindow',
      );
    });
  });

  it('en locale emits EUR currency and PRICE_EUR price in collection offers', async () => {
    const enGraph = await collectionSchema({ slug: 'kubki', locale: 'en', t, tRaw });
    const enNodes = enGraph['@graph'] as unknown as Node[];
    (enNodes[1].itemListElement ?? []).forEach(({ item }) => {
      expect(item.offers.priceCurrency).toBe('EUR');
      expect((item.offers as unknown as { price: number }).price).toBe(PRICE_EUR.kubki);
      expect(item.offers.shippingDetails?.[0].shippingRate.currency).toBe('EUR');
      expect(item.offers.shippingDetails?.[0].shippingDestination.addressCountry).toBe('IE');
    });
  });

  it('maps live soldIds to SoldOut, leaving the rest at their catalog state', async () => {
    const products = registryProductsByCategory('kubki');
    const soldId = products[0].id; // first piece, e.g. "k01"
    const soldGraph = await collectionSchema({ slug: 'kubki', locale: 'pl', t, tRaw, soldIds: [soldId] });
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
  const products = registryProductsByCategory('kubki');
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

  it('sets brand to Anna Ciok, matching the <g:brand> literal in feed.ts', () => {
    expect(nodes[1]['brand']).toEqual({ '@type': 'Brand', name: 'Anna Ciok' });
  });

  it('attaches ceramics shippingDetails (2 InPost rates) and a 14-day hasMerchantReturnPolicy', () => {
    const offer = nodes[1]['offers'] as {
      shippingDetails: { shippingRate: { value: number; currency: string }; shippingDestination: { addressCountry: string } }[];
      hasMerchantReturnPolicy: { merchantReturnDays: number; returnFees: string };
    };
    expect(offer.shippingDetails).toHaveLength(2);
    offer.shippingDetails.forEach((rate) => {
      expect(rate.shippingRate.currency).toBe('PLN');
      expect(rate.shippingDestination.addressCountry).toBe('PL');
    });
    expect(offer.hasMerchantReturnPolicy.merchantReturnDays).toBe(14);
    expect(offer.hasMerchantReturnPolicy.returnFees).toBe('https://schema.org/ReturnShippingFees');
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

  it('en locale emits EUR currency and PRICE_EUR price in product offer', () => {
    const enGraph = productSchema({ product, locale: 'en', t, tRaw });
    const enNodes = enGraph['@graph'] as unknown as Record<string, unknown>[];
    const enOffer = enNodes[1]['offers'] as { priceCurrency: string; price: number };
    expect(enOffer.priceCurrency).toBe('EUR');
    expect(enOffer.price).toBe(PRICE_EUR.kubki);
  });

  it('uses an explicit description override when CMS content is resolved', () => {
    const cmsGraph = productSchema({ product, locale: 'pl', t, tRaw, description: 'CMS opis' });
    const cmsNodes = cmsGraph['@graph'] as unknown as Record<string, unknown>[];
    expect(cmsNodes[1]['description']).toBe('CMS opis');
  });
});
