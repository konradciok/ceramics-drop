import { describe, it, expect } from 'vitest';
import { getPrintById, getPrintDesigns, isVariantAvailable } from './prints';

describe('getPrintDesigns', () => {
  it('returns only published designs', () => {
    const designs = getPrintDesigns();
    expect(designs.every(d => d.published)).toBe(true);
    expect(designs.map(d => d.id)).toEqual(['fap01', 'fap02', 'fap03']);
    expect(designs.find(d => d.id === 'fap04')).toBeUndefined();
  });
});

describe('getPrintById', () => {
  it('resolves unpublished designs (so checkout can reject them)', () => {
    expect(getPrintById('fap04')?.published).toBe(false);
  });
  it('returns undefined for unknown id', () => {
    expect(getPrintById('unknown')).toBeUndefined();
  });
});

describe('isVariantAvailable', () => {
  const fap01 = getPrintById('fap01')!;

  it('accepts valid unframed variant', () => {
    expect(isVariantAvailable(fap01, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(true);
  });
  it('accepts valid framed+mount variant', () => {
    expect(isVariantAvailable(fap01, { size: '50x70', framed: true, mount: true, frameColour: 'natural' })).toBe(true);
  });
  it('rejects unpublished design', () => {
    const fap04 = getPrintById('fap04')!;
    expect(isVariantAvailable(fap04, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('rejects mount when design does not offer it', () => {
    const fap02 = getPrintById('fap02')!;
    expect(isVariantAvailable(fap02, { size: '30x40', framed: true, mount: true, frameColour: 'black' })).toBe(false);
  });
  it('rejects size not offered by design', () => {
    const fap02 = getPrintById('fap02')!;
    expect(isVariantAvailable(fap02, { size: '70x100', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('rejects framed=false with non-none colour', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isVariantAvailable(fap01, { size: '30x40', framed: false, mount: false, frameColour: 'black' } as any)).toBe(false);
  });
});
