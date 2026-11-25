/* Every surface that DISPLAYS a shipping price must show the CMS-published
   table checkout charges from, never the code constants. A /v1/shipping-rates
   publish that only reached checkout would show buyers one price and charge
   another, and put the on-page JSON-LD out of step with the
   landing page. These tests feed every surface a bundle in which NO rate equals
   its code default, so a surface still reading a constant cannot pass. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Locale } from '@/i18n/routing';
import { PRINT_COUNTRIES, type InternationalShippingRates } from '@/lib/print-shipping';
import { registryProductsByCategory } from '@/lib/products';
import { productSchema } from '@/lib/seo/structured-data';
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
  lockers: {
    es: { pln: 47, eur: 12, gbp: 11 },
    eu: { pln: 71, eur: 17, gbp: 15 },
  },
};

vi.mock('./get', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./get')>();
  return { ...actual, getShippingRatesForDisplay: vi.fn(async () => PUBLISHED) };
});

const t = (key: string) => key;
const tRaw = () => [] as string[];

describe('fixture sanity', () => {
  it('differs from the code defaults for every country, both domestic currencies and every locker zone', () => {
    for (const c of PRINT_COUNTRIES) {
      expect(PUBLISHED.international[c].loose).not.toBe(CODE_SHIPPING_RATES.international[c].loose);
      expect(PUBLISHED.international[c].framed).not.toBe(CODE_SHIPPING_RATES.international[c].framed);
    }
    expect(PUBLISHED.domestic.pln.paczkomat).not.toBe(CODE_SHIPPING_RATES.domestic.pln.paczkomat);
    expect(PUBLISHED.domestic.eur.kurier).not.toBe(CODE_SHIPPING_RATES.domestic.eur.kurier);
    for (const zone of ['es', 'eu'] as const) {
      for (const currency of ['pln', 'eur', 'gbp'] as const) {
        expect(PUBLISHED.lockers[zone][currency]).not.toBe(CODE_SHIPPING_RATES.lockers[zone][currency]);
      }
    }
    // The locker price must come from the lockers table, so it must also
    // differ from the (switched-off) domestic paczkomat column.
    expect(PUBLISHED.lockers.eu.pln).not.toBe(PUBLISHED.domestic.pln.paczkomat);
    expect(PUBLISHED.lockers.eu.eur).not.toBe(PUBLISHED.domestic.eur.paczkomat);
  });
});

type OfferShipping = { shippingRate: { value: number; currency: string }; shippingDestination: { addressCountry: string } };
const shippingOf = (graph: { '@graph': unknown[] }): OfferShipping[] => {
  const product = graph['@graph'].find((n) => (n as { '@type': string })['@type'] === 'Product') as { offers: { shippingDetails: OfferShipping[] } };
  return product.offers.shippingDetails;
};

describe('JSON-LD', () => {
  it('ceramic PDP lists each country\'s published locker zone rate (PLN for pl, EUR otherwise)', () => {
    const product = registryProductsByCategory('kubki')[0];
    // Locker only while courier delivery is switched off (COURIER_ENABLED = false);
    // Spain is the 'es' zone, every other country the 'eu' zone (parcels leave from Spain).
    const expected = (currency: 'pln' | 'eur') => (d: OfferShipping) =>
      PUBLISHED.lockers[d.shippingDestination.addressCountry === 'ES' ? 'es' : 'eu'][currency];
    const pl = shippingOf(productSchema({ product, locale: 'pl' as Locale, t, tRaw, shipping: PUBLISHED }) as never);
    expect(pl.length).toBeGreaterThan(1);
    expect(pl.map((d) => d.shippingRate.value)).toEqual(pl.map(expected('pln')));
    const en = shippingOf(productSchema({ product, locale: 'en' as Locale, t, tRaw, shipping: PUBLISHED }) as never);
    expect(en.map((d) => d.shippingRate.value)).toEqual(en.map(expected('eur')));
  });
});

/* Architecture guard: the code constants may only be defined/consumed where the
   resilience layer and the CMS mapping need them. A new display surface that
   imports one is exactly the bug this file exists to prevent — read
   getShippingRatesForDisplay() (server) and pass the table down instead. */
describe('display surfaces never read the shipping constants', () => {
  const ALLOWED = new Set([
    'src/lib/pricing.ts', // SHIPPING_PLN/EUR/GBP + DEFAULT_DOMESTIC_SHIPPING + DEFAULT_LOCKER_SHIPPING (definitions, shippingEuroCents)
    'src/lib/print-shipping.ts', // SHIPPING_EUR table + DEFAULT_INTERNATIONAL_SHIPPING (definition)
    'src/lib/shipping-rates/last-known-good.ts', // CODE_SHIPPING_RATES (outage / code-mode fallback)
    'src/server/cms-api/shipping-rates-mapping.ts', // CMS API seed/validation
    'src/app/api/checkout/route.ts', // mentions the constants in a comment only (charges from the published bundle)
  ]);
  const NAMES = /\b(SHIPPING_PLN|SHIPPING_EUR|SHIPPING_GBP|DEFAULT_INTERNATIONAL_SHIPPING|DEFAULT_DOMESTIC_SHIPPING|DEFAULT_LOCKER_SHIPPING)\b/;

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

/* A page that reads the published table must render at request time: a
   prerendered route would bake in the build-time code constants (CATALOG_SOURCE
   is unset at build) and a published rate would never show up. */
describe('pages that read the published shipping table are request-time rendered', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /^page\.tsx$/.test(name) ? [p] : [];
    });

  it("each src/app page importing getShippingRatesForDisplay is force-dynamic or uses headers()", () => {
    const root = join(__dirname, '../../..');
    const pages = walk(join(root, 'src/app')).filter((file) => readFileSync(file, 'utf8').includes('getShippingRatesForDisplay'));
    expect(pages.length).toBeGreaterThan(0);
    const static_ = pages.filter((file) => {
      const src = readFileSync(file, 'utf8');
      return !/export const dynamic = 'force-dynamic'/.test(src) && !/\bheaders\(\)/.test(src);
    });
    expect(static_.map((f) => relative(root, f))).toEqual([]);
  });
});
