import { describe, it, expect } from 'vitest';
import { priceOfVariant } from './print-pricing';

const unframed30 = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
const framed50   = { size: '50x70' as const, framed: true,  mount: false, frameColour: 'black' as const };
const mounted70  = { size: '70x100' as const, framed: true, mount: true,  frameColour: 'natural' as const };

describe('priceOfVariant', () => {
  it('returns PLN base for unframed 30x40', () => {
    expect(priceOfVariant(unframed30, 'pln')).toBe(105);
  });
  it('returns EUR for framed 50x70', () => {
    expect(priceOfVariant(framed50, 'eur')).toBe(35);
  });
  it('returns GBP for mounted 70x100', () => {
    expect(priceOfVariant(mounted70, 'gbp')).toBe(38);
  });
});
