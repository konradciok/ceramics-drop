import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { mapCeramicProducts } from './mappers';
import { parseProductRows } from './read-schemas';
import type { ProductSeedRow } from './types';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

function ceramicRow(over: Partial<ProductSeedRow> = {}): ProductSeedRow {
  return {
    id: 'k01',
    type: 'ceramic',
    category_slug: 'kubki',
    num: '01',
    slug: null,
    price_pln: 120,
    price_eur: null,
    price_gbp: null,
    sale_price_pln: null,
    sale_price_eur: null,
    sale_price_gbp: null,
    measure: '9 cm',
    status: 'active',
    seo_title: null,
    seo_description: null,
    drop_id: 'drop-1',
    note_index: 1,
    ...over,
  };
}

/**
 * Fail-closed guard, at the mapper seam: a NULL/0-priced ceramic row must
 * never reach `mapCeramicProducts` and render at 0 zł. `readCeramicProducts`
 * (repository.ts) is the real production wiring — this test exercises the
 * same guard+mapper composition it uses, without a live Supabase client.
 */
describe('mapCeramicProducts, downstream of the read guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('excludes a ceramic row with price_pln: null from the mapped output and reports it', () => {
    const rows = parseProductRows([ceramicRow({ id: 'k01', price_pln: null })]);
    const products = mapCeramicProducts(rows, []);

    expect(products).toEqual([]);
    expect(console.error).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });

  it('excludes a ceramic row with price_pln: 0 from the mapped output and reports it', () => {
    const rows = parseProductRows([ceramicRow({ id: 'k02', price_pln: 0 })]);
    const products = mapCeramicProducts(rows, []);

    expect(products).toEqual([]);
    expect(console.error).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });

  it('keeps a validly priced ceramic row and never falls back to 0', () => {
    const rows = parseProductRows([
      ceramicRow({ id: 'k01', price_pln: null }),
      ceramicRow({ id: 'k03', price_pln: 250 }),
    ]);
    const products = mapCeramicProducts(rows, []);

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ id: 'k03', price: 250 });
  });

  it('never silently defaults price to 0 even if a future caller bypasses the guard', () => {
    // Every production caller (readCeramicProducts) filters through
    // parseProductRows before calling mapCeramicProducts — but this asserts
    // the `?? 0` fallback is gone from the mapper itself, so a hypothetical
    // future bypass fails loudly (a visibly broken price) instead of quietly
    // selling at 0 zł.
    const products = mapCeramicProducts([ceramicRow({ id: 'k04', price_pln: null })], []);
    expect(products[0]?.price).not.toBe(0);
  });
});
