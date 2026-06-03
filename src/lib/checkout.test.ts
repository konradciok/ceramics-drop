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
});
