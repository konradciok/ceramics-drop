/* Every surface that DISPLAYS a shipping price must show the CMS-published
   table checkout charges from, never the code constants. A /v1/shipping-rates
   publish that only reached checkout would show buyers one price and charge
   another, and put the Merchant Center feed / JSON-LD out of step with the
   landing page. These tests feed every surface a bundle in which NO rate equals
   its code default, so a surface still reading a constant cannot pass. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@/i18n/routing';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import { PRINT_COUNTRIES, printShippingOf, type InternationalShippingRates } from '@/lib/print-shipping';
import { registryPrintDesigns } from '@/lib/prints';
import { registryProductsByCategory } from '@/lib/products';
import { printProductSchema, productSchema } from '@/lib/seo/structured-data';
import { CODE_SHIPPING_RATES, type ShippingRatesBundle } from './last-known-good';

const PUBLISHED: ShippingRatesBundle = {
  domestic: {
    pln: { paczkomat: 23, kurier: 37, odbior: 0 },
    eur: { paczkomat: 6, kurier: 11, odbior: 0 },
    gbp: { paczkomat: 5, kurier: 9, odbior: 0 },
  },
  international: Object.fromEntries(
    PRINT_COUNTRIES.map((c) => [
      c,
      { framed: CODE_SHIPPING_RATES.international[c].framed + 3.5, loose: CODE_SHIPPING_RATES.international[c].loose + 2.5 },
    ]),
  ) as InternationalShippingRates,
};

vi.mock('./get', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./get')>();
  return { ...actual, getShippingRatesForDisplay: vi.fn(async () => PUBLISHED) };
});
vi.mock('../print-collections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../print-collections')>();
  return { ...actual, loadPrintCollectionDefinitions: vi.fn(async () => []) };
});

const t = (key: string) => key;
const tRaw = () => [] as string[];

describe('fixture sanity', () => {
  it('differs from the code defaults for every country and both domestic currencies', () => {
    for (const c of PRINT_COUNTRIES) {
      expect(PUBLISHED.international[c].loose).not.toBe(CODE_SHIPPING_RATES.international[c].loose);
      expect(PUBLISHED.international[c].framed).not.toBe(CODE_SHIPPING_RATES.international[c].framed);
    }
    expect(PUBLISHED.domestic.pln.paczkomat).not.toBe(CODE_SHIPPING_RATES.domestic.pln.paczkomat);
    expect(PUBLISHED.domestic.eur.kurier).not.toBe(CODE_SHIPPING_RATES.domestic.eur.kurier);
  });
});

describe('merchant feed', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['pl', 'PLN', 'pln'],
    ['gb', 'GBP', 'gbp'],
    ['eu', 'EUR', 'eur'],
  ] as const)('%s market advertises the published loose rate in %s', async (marketId, code, currency) => {
    const { buildGoogleFeedItems } = await import('../feed');
    const items = await buildGoogleFeedItems(marketId);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.shipping.length).toBeGreaterThan(0);
      for (const s of item.shipping) {
        const expected = printShippingOf(s.country as (typeof PRINT_COUNTRIES)[number], false, currency, DEFAULT_PRINT_PRICING, PUBLISHED.international);
        const fromCode = printShippingOf(s.country as (typeof PRINT_COUNTRIES)[number], false, currency, DEFAULT_PRINT_PRICING);
        expect(s.price).toBe(`${expected}.00 ${code}`);
        expect(expected, `${s.country} fixture must differ from the code default`).not.toBe(fromCode);
      }
    }
  });
});

type OfferShipping = { shippingRate: { value: number; currency: string }; shippingDestination: { addressCountry: string } };
const shippingOf = (graph: { '@graph': unknown[] }): OfferShipping[] => {
  const product = graph['@graph'].find((n) => (n as { '@type': string })['@type'] === 'Product') as { offers: { shippingDetails: OfferShipping[] } };
  return product.offers.shippingDetails;
};

describe('JSON-LD', () => {
  it.each([
    ['en', 'gbp'],
    ['es', 'eur'],
    ['pl', 'pln'],
  ] as const)('print PDP (%s) lists the published loose and framed rate per destination in %s', (locale, currency) => {
    const design = registryPrintDesigns()[0];
    const graph = printProductSchema({ design, locale: locale as Locale, t, tRaw, pricing: DEFAULT_PRINT_PRICING, shipping: PUBLISHED });
    const details = shippingOf(graph as never);
    expect(details.length).toBeGreaterThan(0);
    // two entries per country: loose then framed
    for (let i = 0; i < details.length; i += 2) {
      const country = details[i].shippingDestination.addressCountry as (typeof PRINT_COUNTRIES)[number];
      expect(details[i].shippingRate.value).toBe(printShippingOf(country, false, currency, DEFAULT_PRINT_PRICING, PUBLISHED.international));
      expect(details[i + 1].shippingRate.value).toBe(printShippingOf(country, true, currency, DEFAULT_PRINT_PRICING, PUBLISHED.international));
      expect(details[i].shippingRate.value).not.toBe(printShippingOf(country, false, currency, DEFAULT_PRINT_PRICING));
    }
  });

  it('ceramic PDP lists the published InPost rates (PLN for pl, EUR otherwise)', () => {
    const product = registryProductsByCategory('kubki')[0];
    const pl = shippingOf(productSchema({ product, locale: 'pl' as Locale, t, tRaw, shipping: PUBLISHED }) as never);
    expect(pl.map((d) => d.shippingRate.value)).toEqual([PUBLISHED.domestic.pln.paczkomat, PUBLISHED.domestic.pln.kurier]);
    const en = shippingOf(productSchema({ product, locale: 'en' as Locale, t, tRaw, shipping: PUBLISHED }) as never);
    expect(en.map((d) => d.shippingRate.value)).toEqual([PUBLISHED.domestic.eur.paczkomat, PUBLISHED.domestic.eur.kurier]);
  });
});

/* Architecture guard: the code constants may only be defined/consumed where the
   resilience layer and the CMS mapping need them. A new display surface that
   imports one is exactly the bug this file exists to prevent — read
   getShippingRatesForDisplay() (server) and pass the table down instead. */
describe('display surfaces never read the shipping constants', () => {
  const ALLOWED = new Set([
    'src/lib/pricing.ts', // SHIPPING_PLN/EUR/GBP + DEFAULT_DOMESTIC_SHIPPING (definitions, shippingEuroCents)
    'src/lib/print-shipping.ts', // SHIPPING_EUR table + DEFAULT_INTERNATIONAL_SHIPPING (definition)
    'src/lib/shipping-rates/last-known-good.ts', // CODE_SHIPPING_RATES (outage / code-mode fallback)
    'src/server/cms-api/shipping-rates-mapping.ts', // CMS API seed/validation
    'src/app/api/checkout/route.ts', // mentions the constants in a comment only (charges from the published bundle)
  ]);
  const NAMES = /\b(SHIPPING_PLN|SHIPPING_EUR|SHIPPING_GBP|DEFAULT_INTERNATIONAL_SHIPPING|DEFAULT_DOMESTIC_SHIPPING)\b/;

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : [];
    });

  it('only the allow-listed modules mention them', () => {
    const root = join(__dirname, '../../..');
    const offenders = walk(join(root, 'src'))
      .filter((file) => NAMES.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });
});
