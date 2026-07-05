import { describe, it, expect } from 'vitest';
import { validateCart, MAX_CART } from './checkout';
import { encodePrintToken } from './print-cart';

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

  it('resolves items to pence when currency is gbp', () => {
    // k01 is kubki → PRICE_GBP.kubki = 22 → toGBPPence(22) = 2200
    const result = validateCart(['k01'], 'gbp');
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 2200 }] });
  });

  it('accepts a valid print token', () => {
    const token = encodePrintToken('fap01', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    const result = validateCart([token], 'pln');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].variant?.prodigiSku).toBe('GLOBAL-CFP-20X28');
    expect(result.items[0].unit_price).toBe(45500); // (150 base + 305 frame) PLN × 100
  });

  it('rejects a mixed ceramics + prints cart', () => {
    const token = encodePrintToken('fap01', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    expect(validateCart(['k01', token], 'pln')).toEqual({ ok: false, reason: 'mixed_cart' });
  });

  it('rejects an unknown design id in print token', () => {
    const token = encodePrintToken('fap99', { size: '30x40', framed: false, mount: false, frameColour: 'none' });
    expect(validateCart([token], 'pln')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an unpublished design', () => {
    const token = encodePrintToken('fap04', { size: '30x40', framed: false, mount: false, frameColour: 'none' });
    expect(validateCart([token], 'pln')).toEqual({ ok: false, reason: 'unknown' });
  });
});
