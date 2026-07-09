import { describe, it, expect } from 'vitest';
import { resolveProductStatus, isDisplayStatusPurchasable } from './status';

describe('resolveProductStatus', () => {
  const base = { catalogStatus: 'active' as const, categoryHidden: false, piece: null, hasStock: true };

  it('catalogue state wins over stock/sale state', () => {
    expect(resolveProductStatus({ ...base, catalogStatus: 'archived' })).toBe('archived');
    expect(resolveProductStatus({ ...base, catalogStatus: 'draft' })).toBe('draft');
    expect(resolveProductStatus({ ...base, catalogStatus: 'hidden' })).toBe('hidden');
    // A draft that is also sold still reads as draft (not on sale regardless).
    expect(
      resolveProductStatus({ ...base, catalogStatus: 'draft', piece: { status: 'sold', reservedExpired: false } }),
    ).toBe('draft');
  });

  it('hides an active product whose category is withdrawn', () => {
    expect(resolveProductStatus({ ...base, categoryHidden: true })).toBe('hidden');
  });

  it('overlays sold / live-reserved / out-of-stock on an active product', () => {
    expect(resolveProductStatus({ ...base, piece: { status: 'sold', reservedExpired: false } })).toBe('sold');
    expect(resolveProductStatus({ ...base, piece: { status: 'reserved', reservedExpired: false } })).toBe('reserved');
    expect(resolveProductStatus({ ...base, hasStock: false })).toBe('out_of_stock');
    expect(resolveProductStatus(base)).toBe('active');
  });

  it('treats an expired reservation as available (falls through to stock)', () => {
    expect(resolveProductStatus({ ...base, piece: { status: 'reserved', reservedExpired: true } })).toBe('active');
    expect(
      resolveProductStatus({ ...base, piece: { status: 'reserved', reservedExpired: true }, hasStock: false }),
    ).toBe('out_of_stock');
  });

  it('only "active" is purchasable', () => {
    expect(isDisplayStatusPurchasable('active')).toBe(true);
    for (const s of ['draft', 'hidden', 'archived', 'sold', 'reserved', 'out_of_stock'] as const) {
      expect(isDisplayStatusPurchasable(s)).toBe(false);
    }
  });
});
