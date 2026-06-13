import { describe, it, expect } from 'vitest';
import {
  PRINT_DESIGNS,
  getPrintDesigns,
  getPrintById,
  skuOf,
  isVariantAvailable,
} from './prints';

describe('print registry', () => {
  it('every design has a stable `fap`-prefixed unique id', () => {
    const ids = PRINT_DESIGNS.map((d) => d.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^fap\d+$/);
  });

  it('getPrintById resolves known ids and returns undefined otherwise', () => {
    expect(getPrintById('fap01')?.id).toBe('fap01');
    expect(getPrintById('nope')).toBeUndefined();
  });

  it('getPrintById returns unpublished designs (so checkout can reject them)', () => {
    const unpublished = PRINT_DESIGNS.find((d) => !d.published);
    if (unpublished) expect(getPrintById(unpublished.id)?.published).toBe(false);
  });

  it('getPrintDesigns lists only published designs', () => {
    const listed = getPrintDesigns();
    expect(listed.every((d) => d.published)).toBe(true);
    expect(listed.length).toBe(PRINT_DESIGNS.filter((d) => d.published).length);
  });
});

describe('skuOf', () => {
  it('builds a deterministic uppercase SKU from num + axes', () => {
    const d = getPrintById('fap01')!;
    expect(skuOf(d, { size: 'a3', paper: 'satin', frame: 'oak' })).toBe('FAP-01-A3-SATIN-OAK');
    expect(skuOf(d, { size: 'a4', paper: 'matte', frame: 'none' })).toBe('FAP-01-A4-MATTE-NONE');
  });
});

describe('isVariantAvailable', () => {
  it('accepts a combination within the offered axes', () => {
    const d = getPrintById('fap01')!;
    expect(isVariantAvailable(d, { size: 'a3', paper: 'satin', frame: 'oak' })).toBe(true);
  });

  it('rejects a size the design does not offer', () => {
    const d = getPrintById('fap02')!; // offers only a4/a3
    expect(isVariantAvailable(d, { size: 'a2', paper: 'matte', frame: 'none' })).toBe(false);
  });

  it('rejects an explicitly unavailable combination', () => {
    const d = getPrintById('fap02')!; // a3:satin:black is excluded
    expect(isVariantAvailable(d, { size: 'a3', paper: 'satin', frame: 'black' })).toBe(false);
    expect(isVariantAvailable(d, { size: 'a3', paper: 'satin', frame: 'none' })).toBe(true);
  });

  it('rejects every variant of an unpublished design', () => {
    const unpublished = PRINT_DESIGNS.find((d) => !d.published);
    if (unpublished) {
      expect(isVariantAvailable(unpublished, { size: 'a4', paper: 'matte', frame: 'none' })).toBe(false);
    }
  });
});
