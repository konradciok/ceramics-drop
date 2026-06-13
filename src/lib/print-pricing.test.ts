import { describe, it, expect } from 'vitest';
import {
  PRINT_SIZE_BASE,
  PRINT_PAPER_DELTA,
  PRINT_FRAME_DELTA,
  PRINT_PRICE_OVERRIDE,
  priceOfVariant,
} from './print-pricing';
import { toGrosze, toEuroCents } from './pricing';
import type { PrintDesign } from './types';

const design: PrintDesign = {
  id: 'fap01',
  category: 'fine-art-prints',
  num: '01',
  image: '/uploads/fap-01.webp',
  noteIndex: 0,
  sizes: ['a4', 'a3', 'a2'],
  papers: ['matte', 'satin'],
  frames: ['none', 'oak', 'black'],
  published: true,
  fromPLN: 120,
};

describe('priceOfVariant', () => {
  it('sums base + paper delta + frame delta in PLN', () => {
    // a3 base 180 + satin 20 + oak 150 = 350
    expect(priceOfVariant(design, { size: 'a3', paper: 'satin', frame: 'oak' }, 'pln')).toBe(350);
    // a4 base 120 + matte 0 + none 0 = 120 (the "from" price)
    expect(priceOfVariant(design, { size: 'a4', paper: 'matte', frame: 'none' }, 'pln')).toBe(120);
  });

  it('sums base + paper delta + frame delta in EUR', () => {
    // a3 base 43 + satin 5 + oak 36 = 84
    expect(priceOfVariant(design, { size: 'a3', paper: 'satin', frame: 'oak' }, 'eur')).toBe(84);
    // a2 base 62 + matte 0 + black 36 = 98
    expect(priceOfVariant(design, { size: 'a2', paper: 'matte', frame: 'black' }, 'eur')).toBe(98);
  });

  it('the "from" price equals the cheapest axis combination', () => {
    const cheapest = priceOfVariant(design, { size: 'a4', paper: 'matte', frame: 'none' }, 'pln');
    expect(cheapest).toBe(design.fromPLN);
  });

  it('applies a per-(design, variantKey) full-amount override when present', () => {
    const key = `${design.id}:a2:satin:black`;
    PRINT_PRICE_OVERRIDE[key] = { pln: 999, eur: 222 };
    try {
      expect(priceOfVariant(design, { size: 'a2', paper: 'satin', frame: 'black' }, 'pln')).toBe(999);
      expect(priceOfVariant(design, { size: 'a2', paper: 'satin', frame: 'black' }, 'eur')).toBe(222);
    } finally {
      delete PRINT_PRICE_OVERRIDE[key];
    }
  });

  it('converts cleanly to minor units (no fractional grosze / cents)', () => {
    const pln = priceOfVariant(design, { size: 'a3', paper: 'satin', frame: 'oak' }, 'pln');
    const eur = priceOfVariant(design, { size: 'a3', paper: 'satin', frame: 'oak' }, 'eur');
    expect(toGrosze(pln)).toBe(35000);
    expect(toEuroCents(eur)).toBe(8400);
  });

  it('every axis value carries a positive base or non-negative delta', () => {
    for (const v of Object.values(PRINT_SIZE_BASE)) {
      expect(v.pln).toBeGreaterThan(0);
      expect(v.eur).toBeGreaterThan(0);
    }
    for (const v of [...Object.values(PRINT_PAPER_DELTA), ...Object.values(PRINT_FRAME_DELTA)]) {
      expect(v.pln).toBeGreaterThanOrEqual(0);
      expect(v.eur).toBeGreaterThanOrEqual(0);
    }
  });
});
