import { describe, it, expect } from 'vitest';
import { DEFAULT_PRINT_PRICING, derivePrice, fromPriceOf, priceOfVariant } from './print-pricing';
import { PRINT_FRAME_COLOURS } from './print-cart';
import type { PrintDesign } from './types';

const unframed30 = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
const framed50   = { size: '50x70' as const, framed: true,  mount: false, frameColour: 'black' as const };
const mounted70  = { size: '70x100' as const, framed: true, mount: true,  frameColour: 'natural' as const };

const design: PrintDesign = {
  id: 'fap005', category: 'fine-art-prints', num: '05', image: '/uploads/fap-005.webp',
  noteIndex: 0, sizes: ['30x40', '50x70', '70x100'],
  frameColours: ['black', 'natural', 'brown'], mountAvailable: true, published: true,
};

describe('derivePrice', () => {
  it('derives PLN with ×eurToPln rounded to the nearest 5 zł', () => {
    expect(derivePrice(25, 'pln', DEFAULT_PRINT_PRICING)).toBe(105); // 106.25 → 105
    expect(derivePrice(50, 'pln', DEFAULT_PRINT_PRICING)).toBe(215); // 212.50 → 215
    expect(derivePrice(75, 'pln', DEFAULT_PRINT_PRICING)).toBe(320); // 318.75 → 320
    expect(derivePrice(35, 'pln', DEFAULT_PRINT_PRICING)).toBe(150); // 148.75 → 150
  });
  it('derives GBP with ×eurToGbp rounded to 1 £, immune to IEEE noise on .5 cases', () => {
    // Naive Math.round(25 * 0.86) === 21 because 25×0.86 → 21.4999…; the
    // round-to-cents intermediate must yield 21.5 → 22.
    expect(derivePrice(25, 'gbp', DEFAULT_PRINT_PRICING)).toBe(22);
    expect(derivePrice(50, 'gbp', DEFAULT_PRINT_PRICING)).toBe(43);
    expect(derivePrice(75, 'gbp', DEFAULT_PRINT_PRICING)).toBe(65); // 64.5 → 65
    expect(derivePrice(35, 'gbp', DEFAULT_PRINT_PRICING)).toBe(30); // 30.1 → 30
  });
  it('returns EUR as-is', () => {
    expect(derivePrice(75, 'eur', DEFAULT_PRINT_PRICING)).toBe(75);
  });
});

describe('priceOfVariant', () => {
  it('prices the seed table: unframed bases per currency', () => {
    expect(priceOfVariant(unframed30, 'eur', DEFAULT_PRINT_PRICING)).toBe(25);
    expect(priceOfVariant(unframed30, 'pln', DEFAULT_PRINT_PRICING)).toBe(100 + 5); // 105
    expect(priceOfVariant(unframed30, 'gbp', DEFAULT_PRINT_PRICING)).toBe(22);
  });
  it('adds the per-size frame surcharge (50x70 framed: 215 + 150 PLN)', () => {
    expect(priceOfVariant(framed50, 'pln', DEFAULT_PRINT_PRICING)).toBe(365);
    expect(priceOfVariant(framed50, 'eur', DEFAULT_PRINT_PRICING)).toBe(85);
  });
  it('adds frame + mount surcharges (70x100: 320 + 150 + 105 PLN)', () => {
    expect(priceOfVariant(mounted70, 'pln', DEFAULT_PRINT_PRICING)).toBe(575);
    expect(priceOfVariant(mounted70, 'eur', DEFAULT_PRINT_PRICING)).toBe(75 + 35 + 25);
  });
  it('never varies with frame colour', () => {
    for (const currency of ['pln', 'eur', 'gbp'] as const) {
      const prices = PRINT_FRAME_COLOURS.map((frameColour) =>
        priceOfVariant({ ...framed50, frameColour }, currency, DEFAULT_PRINT_PRICING),
      );
      expect(new Set(prices).size, currency).toBe(1);
    }
  });
  it('ignores mount unless the variant is framed', () => {
    const invalidMount = { ...unframed30, mount: true };
    expect(priceOfVariant(invalidMount, 'pln', DEFAULT_PRINT_PRICING)).toBe(
      priceOfVariant(unframed30, 'pln', DEFAULT_PRINT_PRICING),
    );
  });
  it('honours per-size surcharges from an admin-edited config', () => {
    const edited = {
      ...DEFAULT_PRINT_PRICING,
      frameEur: { '30x40': 20, '50x70': 40, '70x100': 60 },
    };
    expect(priceOfVariant({ ...framed50, size: '30x40' }, 'eur', edited)).toBe(25 + 20);
    expect(priceOfVariant(framed50, 'eur', edited)).toBe(50 + 40);
    expect(priceOfVariant({ ...framed50, size: '70x100' }, 'eur', edited)).toBe(75 + 60);
  });
});

describe('fromPriceOf', () => {
  it('returns the cheapest derived base price', () => {
    expect(fromPriceOf(design, 'pln', DEFAULT_PRINT_PRICING)).toBe(105);
    expect(fromPriceOf(design, 'eur', DEFAULT_PRINT_PRICING)).toBe(25);
    expect(fromPriceOf(design, 'gbp', DEFAULT_PRINT_PRICING)).toBe(22);
  });
  it('only considers the sizes the design offers', () => {
    const large: PrintDesign = { ...design, sizes: ['70x100'] };
    expect(fromPriceOf(large, 'eur', DEFAULT_PRINT_PRICING)).toBe(75);
  });
});
