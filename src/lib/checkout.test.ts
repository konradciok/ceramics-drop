import { describe, it, expect } from 'vitest';
import { validateCart, MAX_CART } from './checkout';

describe('validateCart', () => {
  it('maps known ids to products with grosze prices', () => {
    const r = validateCart(['k01', 'v01']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((i) => i.product_id)).toEqual(['k01', 'v01']);
      expect(r.items[0].unit_price).toBe(9500);   // kubki 95 zł
      expect(r.items[1].unit_price).toBe(23900);  // wazony 239 zł
    }
  });

  it('rejects an empty cart', () => {
    expect(validateCart([]).ok).toBe(false);
  });

  it('rejects unknown ids', () => {
    expect(validateCart(['nope']).ok).toBe(false);
  });

  it('dedupes repeated ids (1/1 — one each)', () => {
    const r = validateCart(['k01', 'k01']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(1);
  });

  it('rejects carts above MAX_CART', () => {
    const many = Array.from({ length: MAX_CART + 1 }, (_, i) => `x${i}`);
    expect(validateCart(many).ok).toBe(false);
  });

  it('resolves items to euro-cents when currency is eur', () => {
    // k01 is kubki → PRICE_EUR.kubki = 25 → toEuroCents(25) = 2500
    const result = validateCart(['k01'], 'eur');
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 2500 }] });
  });

  it('default currency (no arg) still produces grosze', () => {
    // k01 is kubki → product.price = PRICE_PLN.kubki = 95 → toGrosze(95) = 9500
    const result = validateCart(['k01']);
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 9500 }] });
  });
});

describe('validateCart — fine-art prints', () => {
  it('prices a print variant server-side (PLN) and attaches the resolved variant', () => {
    // fap01 a3+satin+oak = 150+0+0 = 150 zł → 15000 grosze
    const r = validateCart(['print:fap01:a3:satin:oak']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(1);
      expect(r.items[0]).toEqual({
        product_id: 'fap01',
        unit_price: 15000,
        variant: { size: 'a3', paper: 'satin', frame: 'oak', sku: 'FAP-01-A3-SATIN-OAK' },
      });
    }
  });

  it('prices a print variant in euro-cents when currency is eur', () => {
    // fap01 a3+satin+oak = 35+0+0 = 35 € → 3500 cents
    const r = validateCart(['print:fap01:a3:satin:oak'], 'eur');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].unit_price).toBe(3500);
  });

  it('handles a mixed ceramic + print cart with correct per-line prices', () => {
    const r = validateCart(['k01', 'print:fap01:a4:matte:none']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0]).toEqual({ product_id: 'k01', unit_price: 9500 });
      expect(r.items[1]).toEqual({
        product_id: 'fap01',
        unit_price: 10500, // a4 base 105 zł
        variant: { size: 'a4', paper: 'matte', frame: 'none', sku: 'FAP-01-A4-MATTE-NONE' },
      });
    }
  });

  it('keeps two different variants of the same design as separate lines', () => {
    const r = validateCart(['print:fap01:a4:matte:none', 'print:fap01:a3:matte:none']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(2);
  });

  it('rejects a structurally invalid token', () => {
    expect(validateCart(['print:fap01:a3:satin']).ok).toBe(false);
    expect(validateCart(['print:fap01:a5:satin:oak']).ok).toBe(false);
  });

  it('rejects an unknown design id', () => {
    expect(validateCart(['print:nope:a3:satin:oak']).ok).toBe(false);
  });

  it('rejects an unpublished design', () => {
    // fap03 is published:false in the registry
    expect(validateCart(['print:fap03:a3:satin:oak']).ok).toBe(false);
  });

  it('rejects a combination the design does not offer', () => {
    // fap02 excludes a3:satin:black and does not offer a2
    expect(validateCart(['print:fap02:a3:satin:black']).ok).toBe(false);
    expect(validateCart(['print:fap02:a2:matte:none']).ok).toBe(false);
  });
});
