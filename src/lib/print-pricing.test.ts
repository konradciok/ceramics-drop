import { describe, it, expect } from 'vitest';
import {
  PRINT_SIZE_BASE,
  PRINT_PAPER_DELTA,
  PRINT_FRAME_DELTA,
  priceOfVariant,
} from './print-pricing';
import { toGrosze, toEuroCents, toGBPPence } from './pricing';
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
  fromPLN: 105,
};

describe('priceOfVariant', () => {
  it('sums base + paper delta + frame delta in PLN', () => {
    // a3 base 150 + satin 0 + oak 0 = 150
    expect(priceOfVariant({ size: 'a3', paper: 'satin', frame: 'oak' }, 'pln')).toBe(150);
    // a4 base 105 + matte 0 + none 0 = 105 (the "from" price)
    expect(priceOfVariant({ size: 'a4', paper: 'matte', frame: 'none' }, 'pln')).toBe(105);
  });

  it('sums base + paper delta + frame delta in EUR', () => {
    // a3 base 35 + satin 0 + oak 0 = 35
    expect(priceOfVariant({ size: 'a3', paper: 'satin', frame: 'oak' }, 'eur')).toBe(35);
    // a2 base 45 + matte 0 + black 0 = 45
    expect(priceOfVariant({ size: 'a2', paper: 'matte', frame: 'black' }, 'eur')).toBe(45);
  });

  it('sums base + paper delta + frame delta in GBP', () => {
    // a3 base 30 + satin 0 + oak 0 = 30
    expect(priceOfVariant({ size: 'a3', paper: 'satin', frame: 'oak' }, 'gbp')).toBe(30);
    // a2 base 38 + matte 0 + black 0 = 38
    expect(priceOfVariant({ size: 'a2', paper: 'matte', frame: 'black' }, 'gbp')).toBe(38);
  });

  it('the "from" price equals the cheapest axis combination', () => {
    const cheapest = priceOfVariant({ size: 'a4', paper: 'matte', frame: 'none' }, 'pln');
    expect(cheapest).toBe(design.fromPLN);
  });

  it('converts cleanly to minor units (no fractional grosze / cents / pence)', () => {
    const pln = priceOfVariant({ size: 'a3', paper: 'satin', frame: 'oak' }, 'pln');
    const eur = priceOfVariant({ size: 'a3', paper: 'satin', frame: 'oak' }, 'eur');
    const gbp = priceOfVariant({ size: 'a3', paper: 'satin', frame: 'oak' }, 'gbp');
    expect(toGrosze(pln)).toBe(15000);
    expect(toEuroCents(eur)).toBe(3500);
    expect(toGBPPence(gbp)).toBe(3000);
  });

  it('every axis value carries a positive base or non-negative delta', () => {
    for (const v of Object.values(PRINT_SIZE_BASE)) {
      expect(v.pln).toBeGreaterThan(0);
      expect(v.eur).toBeGreaterThan(0);
      expect(v.gbp).toBeGreaterThan(0);
    }
    for (const v of [...Object.values(PRINT_PAPER_DELTA), ...Object.values(PRINT_FRAME_DELTA)]) {
      expect(v.pln).toBeGreaterThanOrEqual(0);
      expect(v.eur).toBeGreaterThanOrEqual(0);
      expect(v.gbp).toBeGreaterThanOrEqual(0);
    }
  });
});
