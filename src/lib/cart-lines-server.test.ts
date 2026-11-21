import { afterEach, describe, it, expect, vi } from 'vitest';
import { encodeGiftCardToken } from './gift-cards';
import type { Product } from './types';

// Mock the DB catalog loader so DB-only fixtures can be exercised without a
// real Supabase connection — same pattern as checkout.test.ts.
vi.mock('./catalog/load', () => ({
  loadCeramicProductsFromDb: vi.fn(),
}));
import { loadCeramicProductsFromDb } from './catalog/load';

import { resolveCartLinesServer } from './cart-lines-server';

function dbOnlyProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prd_db_only',
    category: 'kubki',
    num: '99',
    image: '/uploads/db-only.webp',
    price: 12000,
    measure: '9 × 9 cm',
    sold: false,
    dropId: 'drop-1',
    noteIndex: 0,
    ...overrides,
  };
}

const RETIRED_PRINT = 'print:fap005:50x70:true:false:black';

describe('resolveCartLinesServer (CATALOG_SOURCE=code)', () => {
  it('resolves a retired print token to an unavailable line, keeping order', async () => {
    const lines = await resolveCartLinesServer(['k01', RETIRED_PRINT], 'pl');
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'ceramic', id: 'k01' }),
      { kind: 'unavailable', id: RETIRED_PRINT },
    ]);
  });

  it('dedupes identical entries', async () => {
    expect(await resolveCartLinesServer(['k01', 'k01'], 'pl')).toHaveLength(1);
    expect(await resolveCartLinesServer([RETIRED_PRINT, RETIRED_PRINT], 'pl')).toHaveLength(1);
  });

  it('resolves unknown ids to an explicit unavailable line', async () => {
    expect(await resolveCartLinesServer(['nope'], 'pl')).toEqual([{ kind: 'unavailable', id: 'nope' }]);
  });

  it('resolves a gift-card token to a giftcard line', async () => {
    const lines = await resolveCartLinesServer(['giftcard:gc-500'], 'pl');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'giftcard', id: 'giftcard:gc-500', tier: { id: 'gc-500' } });
  });

  it('resolves an unknown gift-card tier to an unavailable line', async () => {
    expect(await resolveCartLinesServer(['giftcard:gc-999'], 'pl')).toEqual([
      { kind: 'unavailable', id: 'giftcard:gc-999' },
    ]);
  });

  it('resolves a mixed ceramic + gift-card cart as separate lines (checkout enforces exclusivity, not this resolver)', async () => {
    const lines = await resolveCartLinesServer(['k01', 'giftcard:gc-200'], 'pl');
    expect(lines.map((l) => l.kind)).toEqual(['ceramic', 'giftcard']);
  });

  it('without a DB-mode catalog, a DB-only id is unavailable like any unknown id', async () => {
    expect(await resolveCartLinesServer(['prd_db_only'], 'pl')).toEqual([{ kind: 'unavailable', id: 'prd_db_only' }]);
  });

  it('round-trips a real encoded gift-card token', async () => {
    const lines = await resolveCartLinesServer([encodeGiftCardToken('gc-500')], 'pl');
    expect(lines.map((l) => l.kind)).toEqual(['giftcard']);
  });
});

describe('resolveCartLinesServer (CATALOG_SOURCE=db)', () => {
  const original = process.env.CATALOG_SOURCE;
  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = original;
    vi.clearAllMocks();
  });

  it('resolves a DB-only ceramic (CMS-created, absent from the code registry)', async () => {
    process.env.CATALOG_SOURCE = 'db';
    const product = dbOnlyProduct();
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([product]);
    const lines = await resolveCartLinesServer(['prd_db_only'], 'pl');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'ceramic', id: 'prd_db_only' });
    if (lines[0].kind === 'ceramic') expect(lines[0].product.id).toBe('prd_db_only');
  });

  it('treats a withdrawn (non-active status) DB ceramic as unavailable, closing the old silent-drop gap', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([dbOnlyProduct({ status: 'hidden' })]);
    expect(await resolveCartLinesServer(['prd_db_only'], 'pl')).toEqual([{ kind: 'unavailable', id: 'prd_db_only' }]);
  });

});
