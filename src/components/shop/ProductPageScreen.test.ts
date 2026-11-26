import { describe, expect, it } from 'vitest';
import { registryProducts } from '@/lib/products';
import { hasDropListSignup, hasStickyBuy, isHeldByCheckout } from './ProductPageScreen';

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

describe('hasDropListSignup (next-drop signup on the PDP)', () => {
  it('is on for every sold piece, whatever else is true of it', () => {
    expect(hasDropListSignup({ ...base(), sold: true })).toBe(true);
    expect(hasDropListSignup({ ...base(), sold: true, onlineAvailable: false })).toBe(true);
    expect(hasDropListSignup({ ...base(), sold: true, showroom: true })).toBe(true);
  });

  it('is off for a piece that can still be bought', () => {
    expect(hasDropListSignup(base())).toBe(false);
  });

  it('is off for an unsold showroom or offline piece (they keep their studio CTA)', () => {
    expect(hasDropListSignup({ ...base(), showroom: true })).toBe(false);
    expect(hasDropListSignup({ ...base(), onlineAvailable: false })).toBe(false);
  });
});

describe('isHeldByCheckout (reserved PDP state)', () => {
  it('is on for an unsold piece under an open checkout reservation', () => {
    expect(isHeldByCheckout({ ...base(), onlineAvailable: false, saleState: 'reserved' })).toBe(true);
  });

  it('is off for a purchasable, a sold and an archive piece', () => {
    expect(isHeldByCheckout(base())).toBe(false);
    expect(isHeldByCheckout({ ...base(), sold: true, onlineAvailable: false, saleState: 'sold' })).toBe(false);
    expect(isHeldByCheckout({ ...base(), onlineAvailable: false, saleState: 'archive' })).toBe(false);
  });

  it('is off for a showroom piece even if a stale reservation lingers', () => {
    expect(isHeldByCheckout({ ...base(), showroom: true, onlineAvailable: false, saleState: 'reserved' })).toBe(false);
  });
});
