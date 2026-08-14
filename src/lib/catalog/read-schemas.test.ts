import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { parseProductRow, parseProductRows } from './read-schemas';
import type { ProductSeedRow } from './types';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

/** A minimally valid ceramic products-table row (all required columns present). */
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

/** A minimally valid print products-table row — price_pln is intentionally nullable. */
function printRow(over: Partial<ProductSeedRow> = {}): ProductSeedRow {
  return {
    ...ceramicRow(),
    id: 'fap01',
    type: 'print',
    category_slug: 'fine-art-prints',
    price_pln: null,
    ...over,
  };
}

describe('parseProductRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a valid ceramic row and reports nothing', () => {
    const row = ceramicRow();
    const result = parseProductRow(row);
    expect(result).toEqual({ ok: true, row });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('rejects a ceramic row with price_pln: null and reports to console + Sentry', () => {
    const row = ceramicRow({ price_pln: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = parseProductRow(row);

    expect(result.ok).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'catalog row failed validation',
      expect.objectContaining({
        extra: expect.objectContaining({ productId: 'k01' }),
      }),
    );
    errSpy.mockRestore();
  });

  it('rejects a ceramic row with price_pln: 0 and reports to console + Sentry', () => {
    const row = ceramicRow({ price_pln: 0 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = parseProductRow(row);

    expect(result.ok).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('passes a print row with price_pln: null through untouched, no report', () => {
    const row = printRow({ price_pln: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = parseProductRow(row);

    expect(result).toEqual({ ok: true, row });
    expect(errSpy).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('parseProductRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('filters out invalid ceramic rows and keeps the rest, reporting each drop', () => {
    const good = ceramicRow({ id: 'k01' });
    const badNull = ceramicRow({ id: 'k02', price_pln: null });
    const badZero = ceramicRow({ id: 'k03', price_pln: 0 });
    const goodPrint = printRow({ id: 'fap01', price_pln: null });

    const out = parseProductRows([good, badNull, badZero, goodPrint]);

    expect(out.map((r) => r.id)).toEqual(['k01', 'fap01']);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
  });
});
