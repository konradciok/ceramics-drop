import { describe, it, expect } from 'vitest';
import { priceOfVariant, fromPriceOf } from './print-pricing';
import type { PrintDesign } from './types';

const unframed30 = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
const framed50   = { size: '50x70' as const, framed: true,  mount: false, frameColour: 'black' as const };
const mounted70  = { size: '70x100' as const, framed: true, mount: true,  frameColour: 'natural' as const };

const design: PrintDesign = {
  id: 'fap01', category: 'fine-art-prints', num: '01', image: '/uploads/fap-01.svg',
  noteIndex: 0, sizes: ['30x40', '50x70', '70x100'],
  frameColours: ['black', 'white', 'natural'], mountAvailable: true, published: true,
};

// Premium series (e.g. Ostrea): per-size override beats the shared base.
const premium: PrintDesign = {
  ...design,
  id: 'fap02',
  prices: { '50x70': { pln: 340, eur: 80, gbp: 68 } },
};

describe('priceOfVariant', () => {
  it('returns PLN base for unframed 30x40', () => {
    expect(priceOfVariant(design, unframed30, 'pln')).toBe(105);
  });
  it('returns EUR for framed 50x70', () => {
    expect(priceOfVariant(design, framed50, 'eur')).toBe(35);
  });
  it('returns GBP for mounted 70x100', () => {
    expect(priceOfVariant(design, mounted70, 'gbp')).toBe(38);
  });
  it('applies per-design price overrides', () => {
    expect(priceOfVariant(premium, framed50, 'eur')).toBe(80);
    // Non-overridden sizes fall back to the shared base.
    expect(priceOfVariant(premium, unframed30, 'eur')).toBe(25);
  });
});

describe('fromPriceOf', () => {
  it('returns the cheapest size price', () => {
    expect(fromPriceOf(design, 'pln')).toBe(105);
    expect(fromPriceOf(design, 'gbp')).toBe(22);
  });
  it('respects overrides when computing the minimum', () => {
    const allPremium: PrintDesign = { ...design, sizes: ['50x70'], prices: { '50x70': { pln: 340, eur: 80, gbp: 68 } } };
    expect(fromPriceOf(allPremium, 'eur')).toBe(80);
  });
});
