import { describe, it, expect, beforeAll } from 'vitest';
import { getPrintById, getPrintDesigns, isVariantAvailable } from './prints';
import { PRINT_FRAME_COLOURS, PRODIGI_SKU_MAP, variantKey } from './print-cart';
import { priceOfVariant } from './print-pricing';
import type { PrintDesign, PrintVariantSelection } from './types';

describe('getPrintDesigns', () => {
  it('returns only published designs', async () => {
    const designs = await getPrintDesigns();
    expect(designs.every(d => d.published)).toBe(true);
    expect(designs.map(d => d.id)).toEqual(['fap01', 'fap02', 'fap03']);
    expect(designs.find(d => d.id === 'fap04')).toBeUndefined();
  });
});

describe('getPrintById', () => {
  it('resolves unpublished designs (so checkout can reject them)', async () => {
    expect((await getPrintById('fap04'))?.published).toBe(false);
  });
  it('returns undefined for unknown id', async () => {
    expect(await getPrintById('unknown')).toBeUndefined();
  });
});

describe('isVariantAvailable', () => {
  let fap01: PrintDesign;
  beforeAll(async () => {
    fap01 = (await getPrintById('fap01'))!;
  });

  it('accepts valid unframed variant', () => {
    expect(isVariantAvailable(fap01, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(true);
  });
  it('accepts valid framed+mount variant', () => {
    expect(isVariantAvailable(fap01, { size: '50x70', framed: true, mount: true, frameColour: 'natural' })).toBe(true);
  });
  it('rejects unpublished design', async () => {
    const fap04 = (await getPrintById('fap04'))!;
    expect(isVariantAvailable(fap04, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  // 2026-08-03: fap02 widened to full axes (every print offers every variant),
  // so the narrow-axes rejection paths are covered with synthetic shapes.
  it('rejects mount when design does not offer it', () => {
    const noMount: PrintDesign = { ...fap01, mountAvailable: false };
    expect(isVariantAvailable(noMount, { size: '30x40', framed: true, mount: true, frameColour: 'black' })).toBe(false);
  });
  it('rejects size not offered by design', () => {
    const small: PrintDesign = { ...fap01, sizes: ['30x40', '50x70'] };
    expect(isVariantAvailable(small, { size: '70x100', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('accepts the formerly restricted fap02 variants (full-axes policy)', async () => {
    const fap02 = (await getPrintById('fap02'))!;
    expect(isVariantAvailable(fap02, { size: '30x40', framed: true, mount: true, frameColour: 'black' })).toBe(true);
    expect(isVariantAvailable(fap02, { size: '70x100', framed: false, mount: false, frameColour: 'none' })).toBe(true);
    expect(isVariantAvailable(fap02, { size: '50x70', framed: true, mount: false, frameColour: 'brown' })).toBe(true);
  });
  it('rejects framed=false with non-none colour', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isVariantAvailable(fap01, { size: '30x40', framed: false, mount: false, frameColour: 'black' } as any)).toBe(false);
  });
});

describe('published print variant coverage', () => {
  it('has SKU and pricing coverage for every sellable variant', async () => {
    let checked = 0;
    for (const design of await getPrintDesigns()) {
      for (const size of design.sizes) {
        // Mirror sellable axes directly: mount only when the design offers it,
        // so the sweep never generates a combo that isVariantAvailable must skip.
        const selections: PrintVariantSelection[] = [
          { size, framed: false, mount: false, frameColour: 'none' },
          ...PRINT_FRAME_COLOURS.flatMap((frameColour) => {
            const framed: PrintVariantSelection[] = [{ size, framed: true, mount: false, frameColour }];
            if (design.mountAvailable) framed.push({ size, framed: true, mount: true, frameColour });
            return framed;
          }),
        ];

        for (const sel of selections) {
          if (!isVariantAvailable(design, sel)) continue;
          const key = variantKey(sel);
          expect(PRODIGI_SKU_MAP[key], `${design.id} ${key}`).toBeDefined();
          expect(priceOfVariant(design, sel, 'pln'), `${design.id} ${key} PLN`).toBeGreaterThan(0);
          expect(priceOfVariant(design, sel, 'eur'), `${design.id} ${key} EUR`).toBeGreaterThan(0);
          expect(priceOfVariant(design, sel, 'gbp'), `${design.id} ${key} GBP`).toBeGreaterThan(0);
          checked++;
        }
      }
    }
    // Guard against a silent green pass: if availability rules change such that
    // nothing is exercised, fail loudly instead of reporting vacuous coverage.
    expect(checked).toBeGreaterThan(0);
  });
});
