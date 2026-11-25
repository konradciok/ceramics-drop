import { describe, expect, it } from 'vitest';
import { registryProducts } from '@/lib/products';
import { hasStickyBuy } from './ProductPageScreen';

const base = () => ({ ...registryProducts().find((p) => p.category === 'kubki')!, onlineAvailable: true, sold: false, showroom: false });

describe('hasStickyBuy (mobile PDP buy bar)', () => {
  it('is on for a piece that can be bought online', () => {
    expect(hasStickyBuy(base())).toBe(true);
  });

  it('is off for a sold piece', () => {
    expect(hasStickyBuy({ ...base(), sold: true })).toBe(false);
  });

  it('is off for a showroom piece', () => {
    expect(hasStickyBuy({ ...base(), showroom: true })).toBe(false);
  });

  it('is off for a piece not on sale online (ended drop, reserved, unavailable)', () => {
    expect(hasStickyBuy({ ...base(), onlineAvailable: false })).toBe(false);
  });
});
