import { describe, it, expect } from 'vitest';
import { validateCart, MAX_CART } from './checkout';

describe('validateCart', () => {
  it('maps known ids to products with grosze prices', () => {
    const r = validateCart(['k01', 'v01']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((i) => i.product_id)).toEqual(['k01', 'v01']);
      expect(r.items[0].unit_price).toBe(9000);   // kubki 90 zł
      expect(r.items[1].unit_price).toBe(21000);  // wazony 210 zł
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
    // k01 is kubki → PRICE_EUR.kubki = 22 → toEuroCents(22) = 2200
    const result = validateCart(['k01'], 'eur');
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 2200 }] });
  });

  it('default currency (no arg) still produces grosze', () => {
    // k01 is kubki → product.price = PRICE_PLN.kubki = 90 → toGrosze(90) = 9000
    const result = validateCart(['k01']);
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 9000 }] });
  });
});
