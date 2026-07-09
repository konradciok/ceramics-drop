import { describe, it, expect } from 'vitest';
import { resolveProductStatus, isDisplayStatusPurchasable } from './status';

describe('resolveProductStatus', () => {
  const base = { catalogStatus: 'active' as const, categoryHidden: false, piece: null, hasStock: true };

  const pieceOf = (
    status: 'available' | 'reserved' | 'sold',
    extra: { reservedExpired?: boolean; showroom?: boolean } = {},
  ) => ({ status, reservedExpired: extra.reservedExpired ?? false, showroom: extra.showroom ?? false });

  it('catalogue state wins over stock/sale state', () => {
    expect(resolveProductStatus({ ...base, catalogStatus: 'archived' })).toBe('archived');
    expect(resolveProductStatus({ ...base, catalogStatus: 'draft' })).toBe('draft');
    expect(resolveProductStatus({ ...base, catalogStatus: 'hidden' })).toBe('hidden');
    // A draft that is also sold still reads as draft (not on sale regardless).
    expect(resolveProductStatus({ ...base, catalogStatus: 'draft', piece: pieceOf('sold') })).toBe('draft');
  });

  it('hides an active product whose category is withdrawn', () => {
    expect(resolveProductStatus({ ...base, categoryHidden: true })).toBe('hidden');
  });

  it('overlays sold / live-reserved / out-of-stock on an active product', () => {
    expect(resolveProductStatus({ ...base, piece: pieceOf('sold') })).toBe('sold');
    expect(resolveProductStatus({ ...base, piece: pieceOf('reserved') })).toBe('reserved');
    expect(resolveProductStatus({ ...base, hasStock: false })).toBe('out_of_stock');
    expect(resolveProductStatus(base)).toBe('active');
  });

  it('marks a showroom piece as showroom (visible, not purchasable)', () => {
    expect(resolveProductStatus({ ...base, piece: pieceOf('available', { showroom: true }) })).toBe('showroom');
    // sold takes precedence: a sold piece retired into the showroom still reads sold.
    expect(resolveProductStatus({ ...base, piece: pieceOf('sold', { showroom: true }) })).toBe('sold');
  });

  it('treats an expired reservation as available (falls through to stock)', () => {
    expect(resolveProductStatus({ ...base, piece: pieceOf('reserved', { reservedExpired: true }) })).toBe('active');
    expect(
      resolveProductStatus({ ...base, piece: pieceOf('reserved', { reservedExpired: true }), hasStock: false }),
    ).toBe('out_of_stock');
  });

  it('only "active" is purchasable', () => {
    expect(isDisplayStatusPurchasable('active')).toBe(true);
    for (const s of ['draft', 'hidden', 'archived', 'sold', 'showroom', 'reserved', 'out_of_stock'] as const) {
      expect(isDisplayStatusPurchasable(s)).toBe(false);
    }
  });
});
