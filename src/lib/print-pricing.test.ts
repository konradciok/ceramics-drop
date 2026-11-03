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

/* The canonical customer-facing price list (owner decision 2026-11-02). Every
   other price surface — the DB seed row, product_variants shadow rows, the
   feeds, JSON-LD — derives from DEFAULT_PRINT_PRICING, so pinning the full
   matrix here is what keeps "canonical everywhere" true. */
describe('canonical price table (no mount)', () => {
  const sizes = ['30x40', '50x70', '70x100'] as const;
  const table = {
    '30x40':  { unframed: { eur: 42,  pln: 180, gbp: 36  }, framed: { eur: 91,  pln: 390, gbp: 78  } },
    '50x70':  { unframed: { eur: 79,  pln: 335, gbp: 68  }, framed: { eur: 158, pln: 670, gbp: 136 } },
    '70x100': { unframed: { eur: 119, pln: 505, gbp: 102 }, framed: { eur: 218, pln: 925, gbp: 187 } },
  } as const;
  for (const size of sizes) {
    for (const currency of ['eur', 'pln', 'gbp'] as const) {
      it(`${size} ${currency}: unframed + framed`, () => {
        const unframed = { size, framed: false, mount: false, frameColour: 'none' as const };
        const framed = { size, framed: true, mount: false, frameColour: 'black' as const };
        expect(priceOfVariant(unframed, currency, DEFAULT_PRINT_PRICING)).toBe(table[size].unframed[currency]);
        expect(priceOfVariant(framed, currency, DEFAULT_PRINT_PRICING)).toBe(table[size].framed[currency]);
      });
    }
  }
});

describe('derivePrice', () => {
  it('derives PLN with ×eurToPln rounded to the nearest 5 zł', () => {
    expect(derivePrice(42, 'pln', DEFAULT_PRINT_PRICING)).toBe(180); // 178.50 → 180
    expect(derivePrice(79, 'pln', DEFAULT_PRINT_PRICING)).toBe(335); // 335.75 → 335
    expect(derivePrice(119, 'pln', DEFAULT_PRINT_PRICING)).toBe(505); // 505.75 → 505
    expect(derivePrice(49, 'pln', DEFAULT_PRINT_PRICING)).toBe(210); // 208.25 → 210
    expect(derivePrice(99, 'pln', DEFAULT_PRINT_PRICING)).toBe(420); // 420.75 → 420
  });
  it('derives GBP with ×eurToGbp rounded to 1 £, immune to IEEE noise on .5 cases', () => {
    // Naive Math.round(25 * 0.86) === 21 because 25×0.86 → 21.4999…; the
    // round-to-cents intermediate must yield 21.5 → 22. 25 € and 75 € are no
    // longer seed prices, but still exercise the .5 boundary of derivePrice.
    expect(derivePrice(25, 'gbp', DEFAULT_PRINT_PRICING)).toBe(22);
    expect(derivePrice(75, 'gbp', DEFAULT_PRINT_PRICING)).toBe(65); // 64.5 → 65
    expect(derivePrice(42, 'gbp', DEFAULT_PRINT_PRICING)).toBe(36); // 36.12 → 36
    expect(derivePrice(119, 'gbp', DEFAULT_PRINT_PRICING)).toBe(102); // 102.34 → 102
  });
  it('returns EUR as-is', () => {
    expect(derivePrice(119, 'eur', DEFAULT_PRINT_PRICING)).toBe(119);
  });
});

describe('priceOfVariant', () => {
  it('prices the seed table: unframed bases per currency', () => {
    expect(priceOfVariant(unframed30, 'eur', DEFAULT_PRINT_PRICING)).toBe(42);
    expect(priceOfVariant(unframed30, 'pln', DEFAULT_PRINT_PRICING)).toBe(180);
    expect(priceOfVariant(unframed30, 'gbp', DEFAULT_PRINT_PRICING)).toBe(36);
  });
  it('adds the per-size frame surcharge (50x70 framed: 335 + 335 PLN)', () => {
    expect(priceOfVariant(framed50, 'pln', DEFAULT_PRINT_PRICING)).toBe(670);
    expect(priceOfVariant(framed50, 'eur', DEFAULT_PRINT_PRICING)).toBe(158);
  });
  it('adds frame + mount surcharges (70x100: 505 + 420 + 170 PLN)', () => {
    expect(priceOfVariant(mounted70, 'pln', DEFAULT_PRINT_PRICING)).toBe(1095);
    expect(priceOfVariant(mounted70, 'eur', DEFAULT_PRINT_PRICING)).toBe(119 + 99 + 40);
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
    expect(priceOfVariant({ ...framed50, size: '30x40' }, 'eur', edited)).toBe(42 + 20);
    expect(priceOfVariant(framed50, 'eur', edited)).toBe(79 + 40);
    expect(priceOfVariant({ ...framed50, size: '70x100' }, 'eur', edited)).toBe(119 + 60);
  });
});

describe('fromPriceOf', () => {
  it('returns the cheapest derived base price', () => {
    expect(fromPriceOf(design, 'pln', DEFAULT_PRINT_PRICING)).toBe(180);
    expect(fromPriceOf(design, 'eur', DEFAULT_PRINT_PRICING)).toBe(42);
    expect(fromPriceOf(design, 'gbp', DEFAULT_PRINT_PRICING)).toBe(36);
  });
  it('only considers the sizes the design offers', () => {
    const large: PrintDesign = { ...design, sizes: ['70x100'] };
    expect(fromPriceOf(large, 'eur', DEFAULT_PRINT_PRICING)).toBe(119);
  });
});
