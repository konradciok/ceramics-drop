import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Product } from '@/lib/types';
vi.mock('@/lib/ceramic-sale-state', () => ({
  withCeramicSaleState: async (products: Product[]) => products.map((p) => ({ ...p, onlineAvailable: !p.sold && !p.showroom })),
}));
import { collectionSchema, organizationSchema, productSchema } from './structured-data';
import { registryProductsByCategory } from '@/lib/products';
import { PRICE_EUR } from '@/lib/pricing';
import { CODE_SHIPPING_RATES } from '@/lib/shipping-rates/last-known-good';
import { SITE_URL } from '@/lib/site';
import { EMAIL } from '@/lib/email-addresses';

/** Stub translator: returns the key so assertions are locale-agnostic. */
const t = (key: string) => key;

/**
 * schema-dts types are deliberately strict unions that can't be index-accessed
 * directly; in tests we treat the emitted schema as the plain JSON it serialises to.
 */
type ShippingDetail = {
  shippingRate: { value: number; currency: string };
  shippingDestination: { addressCountry: string };
  deliveryTime?: { handlingTime: { minValue: number; maxValue: number }; transitTime: { minValue: number; maxValue: number } };
};
type ReturnPolicy = {
  returnPolicyCategory: string;
  merchantReturnDays?: number;
  returnFees?: string;
  applicableCountry?: string | string[];
  returnPolicyCountry?: string;
};
type Offer = {
  priceCurrency: string;
  availability: string;
  url: string;
  shippingDetails?: ShippingDetail[];
  hasMerchantReturnPolicy?: ReturnPolicy;
};
type Node = {
  '@type': string;
  numberOfItems?: number;
  itemListElement?: { item: { name?: string; image: string; description?: string; brand?: { name: string }; offers: Offer } }[];
};

/** Every locale's offers ship to the same countries (InPost lockers and points from
 *  Spain), in registry order — Austria and Luxembourg have no lane. */
const SHIP_COUNTRIES = ['ES', 'PT', 'FR', 'DE', 'BE', 'NL', 'IT', 'PL'];

/** One locker rate per country: the `lockers` zone price, Spain 4 and elsewhere 7 transit days. */
function expectShippingPerCountry(details: ShippingDetail[] | undefined, currency: 'PLN' | 'EUR') {
  const key = currency === 'PLN' ? 'pln' : 'eur';
  expect(details?.map((d) => d.shippingDestination.addressCountry)).toEqual(SHIP_COUNTRIES);
  details?.forEach((rate) => {
    const spain = rate.shippingDestination.addressCountry === 'ES';
    expect(rate.shippingRate.currency).toBe(currency);
    expect(rate.shippingRate.value).toBe(CODE_SHIPPING_RATES.lockers[spain ? 'es' : 'eu'][key]);
    expect(rate.deliveryTime?.handlingTime).toMatchObject({ minValue: 0, maxValue: 2 });
    expect(rate.deliveryTime?.transitTime).toMatchObject({ minValue: 1, maxValue: spain ? 4 : 7 });
  });
}

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
    const graph = await collectionSchema({ slug: 'kubki', locale: 'pl', t, tRaw, shipping: CODE_SHIPPING_RATES });
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
      expect(item.brand).toEqual({ '@type': 'Brand', name: 'Anna Ciok Studio' });
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
      shipping: CODE_SHIPPING_RATES,
    });
    const cmsNodes = cmsGraph['@graph'] as unknown as Node[];
    const items = cmsNodes[1].itemListElement ?? [];
    expect(items[0].item.description).toBe('cms note');
    expect(items[1].item.description).toBe('stub note');
  });

  it('falls through to the tRaw notes fallback when the CMS note is an empty string', async () => {
    const products = registryProductsByCategory('kubki');
    const firstId = products[0].id;
    const emptyNoteGraph = await collectionSchema({
      slug: 'kubki',
      locale: 'pl',
      t,
      tRaw,
      notes: { [firstId]: '' },
      shipping: CODE_SHIPPING_RATES,
    });
    const items = (emptyNoteGraph['@graph'][1] as unknown as Node).itemListElement ?? [];
    expect(items[0].item.description).toBe('stub note');
  });

  it('attaches ceramics shippingDetails (with deliveryTime) and a 14-day hasMerchantReturnPolicy to every offer', () => {
    (nodes[1].itemListElement ?? []).forEach(({ item }) => {
      // Locker only (COURIER_ENABLED = false), one entry per destination.
      expectShippingPerCountry(item.offers.shippingDetails, 'PLN');
      expect(item.offers.hasMerchantReturnPolicy?.merchantReturnDays).toBe(14);
      expect(item.offers.hasMerchantReturnPolicy?.returnPolicyCategory).toBe(
        'https://schema.org/MerchantReturnFiniteReturnWindow',
      );
      // The policy covers every country we ship to; returns go back to the studio in Spain.
      expect(item.offers.hasMerchantReturnPolicy?.applicableCountry).toEqual(SHIP_COUNTRIES);
      expect(item.offers.hasMerchantReturnPolicy?.returnPolicyCountry).toBe('ES');
    });
  });

  it('en locale emits EUR currency and PRICE_EUR price in collection offers, shipping to every country', async () => {
    const enGraph = await collectionSchema({ slug: 'kubki', locale: 'en', t, tRaw, shipping: CODE_SHIPPING_RATES });
    const enNodes = enGraph['@graph'] as unknown as Node[];
    (enNodes[1].itemListElement ?? []).forEach(({ item }) => {
      expect(item.offers.priceCurrency).toBe('EUR');
      expect((item.offers as unknown as { price: number }).price).toBe(PRICE_EUR.kubki);
      expectShippingPerCountry(item.offers.shippingDetails, 'EUR');
    });
  });

  it.each(['en', 'es', 'de'] as const)(
    '%s locale ships to every destination (applicableCountry), while returnPolicyCountry stays ES',
    async (locale) => {
      const graph = await collectionSchema({ slug: 'kubki', locale, t, tRaw, shipping: CODE_SHIPPING_RATES });
      const items = (graph['@graph'][1] as unknown as Node).itemListElement ?? [];
      items.forEach(({ item }) => {
        expectShippingPerCountry(item.offers.shippingDetails, 'EUR');
        expect(item.offers.hasMerchantReturnPolicy?.applicableCountry).toEqual(SHIP_COUNTRIES);
        expect(item.offers.hasMerchantReturnPolicy?.returnPolicyCountry).toBe('ES');
      });
    },
  );

  it('maps live soldIds to SoldOut, leaving the rest at their catalog state', async () => {
    const products = registryProductsByCategory('kubki');
    const soldId = products[0].id; // first piece, e.g. "k01"
    const soldGraph = await collectionSchema({ slug: 'kubki', locale: 'pl', t, tRaw, soldIds: [soldId], shipping: CODE_SHIPPING_RATES });
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
  const product = { ...products[0], sold: false, onlineAvailable: true };
  const tRaw = (key: string) => {
    // Return a stub notes array so noteIndex lookup works
    if (key.startsWith('notes.')) return ['test note'];
    return key;
  };
  const graph = productSchema({ product, locale: 'pl', t, tRaw, shipping: CODE_SHIPPING_RATES });
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
    expect(nodes[1]['brand']).toEqual({ '@type': 'Brand', name: 'Anna Ciok Studio' });
  });

  it('attaches ceramics shippingDetails (the InPost locker rate, with deliveryTime) and a 14-day hasMerchantReturnPolicy', () => {
    const offer = nodes[1]['offers'] as { shippingDetails: ShippingDetail[]; hasMerchantReturnPolicy: ReturnPolicy };
    expectShippingPerCountry(offer.shippingDetails, 'PLN');
    expect(offer.hasMerchantReturnPolicy.merchantReturnDays).toBe(14);
    expect(offer.hasMerchantReturnPolicy.returnFees).toBe('https://schema.org/ReturnShippingFees');
    expect(offer.hasMerchantReturnPolicy.applicableCountry).toEqual(SHIP_COUNTRIES);
    expect(offer.hasMerchantReturnPolicy.returnPolicyCountry).toBe('ES');
  });

  it.each(['en', 'es', 'de'] as const)(
    '%s locale ships to every destination (applicableCountry) while returnPolicyCountry stays ES',
    (locale) => {
      const graph = productSchema({ product, locale, t, tRaw, shipping: CODE_SHIPPING_RATES });
      const offer = (graph['@graph'][1] as unknown as Record<string, unknown>)['offers'] as {
        shippingDetails: ShippingDetail[];
        hasMerchantReturnPolicy: ReturnPolicy;
      };
      expectShippingPerCountry(offer.shippingDetails, 'EUR');
      expect(offer.hasMerchantReturnPolicy.applicableCountry).toEqual(SHIP_COUNTRIES);
      expect(offer.hasMerchantReturnPolicy.returnPolicyCountry).toBe('ES');
    },
  );

  it('maps sold flag to SoldOut / InStock availability', () => {
    const availableOffer = (nodes[1]['offers'] as { availability: string });
    expect(availableOffer.availability).toBe('https://schema.org/InStock');

    const soldGraph = productSchema({ product: { ...product, sold: true }, locale: 'pl', t, tRaw, shipping: CODE_SHIPPING_RATES });
    const soldOffer = (soldGraph['@graph'][1] as unknown as Record<string, { availability: string }>)['offers'];
    expect(soldOffer.availability).toBe('https://schema.org/SoldOut');
  });

  it('en locale uses /en/ prefix in URLs', () => {
    const enGraph = productSchema({ product, locale: 'en', t, tRaw, shipping: CODE_SHIPPING_RATES });
    const enNodes = enGraph['@graph'] as unknown as Record<string, unknown>[];
    const enOffer = enNodes[1]['offers'] as { url: string };
    expect(enOffer.url).toBe(`${SITE_URL}/en/kubki/${product.id}`);
  });

  it('en locale emits EUR currency and PRICE_EUR price in product offer', () => {
    const enGraph = productSchema({ product, locale: 'en', t, tRaw, shipping: CODE_SHIPPING_RATES });
    const enNodes = enGraph['@graph'] as unknown as Record<string, unknown>[];
    const enOffer = enNodes[1]['offers'] as { priceCurrency: string; price: number };
    expect(enOffer.priceCurrency).toBe('EUR');
    expect(enOffer.price).toBe(PRICE_EUR.kubki);
  });

  it('uses an explicit description override when CMS content is resolved', () => {
    const cmsGraph = productSchema({ product, locale: 'pl', t, tRaw, description: 'CMS opis', shipping: CODE_SHIPPING_RATES });
    const cmsNodes = cmsGraph['@graph'] as unknown as Record<string, unknown>[];
    expect(cmsNodes[1]['description']).toBe('CMS opis');
  });

  it('falls through to the tRaw fallback when the description override is an empty string', () => {
    const emptyGraph = productSchema({ product, locale: 'pl', t, tRaw, description: '', shipping: CODE_SHIPPING_RATES });
    const emptyNodes = emptyGraph['@graph'] as unknown as Record<string, unknown>[];
    expect(emptyNodes[1]['description']).toBe('test note');
  });
});
