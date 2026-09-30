import { describe, expect, it } from 'vitest';
import { analyseColours, classifyPixel, rgbToHsv } from './print-colour';

/** Flat RGB buffer of `n` copies of one colour. */
const solid = (rgb: [number, number, number], n: number) => Array.from({ length: n }, () => rgb).flat();

describe('rgbToHsv', () => {
  it('maps primaries to the expected hues', () => {
    expect(rgbToHsv(255, 0, 0).h).toBe(0);
    expect(rgbToHsv(0, 255, 0).h).toBe(120);
    expect(rgbToHsv(0, 0, 255).h).toBe(240);
  });

  it('reports zero saturation for greys', () => {
    expect(rgbToHsv(128, 128, 128).s).toBe(0);
  });
});

describe('classifyPixel', () => {
  it('skips white and warm-white paper', () => {
    expect(classifyPixel(255, 255, 255)).toBeNull();
    expect(classifyPixel(248, 244, 236)).toBeNull();
  });

  it('classifies the palette families', () => {
    expect(classifyPixel(30, 60, 140)).toBe('blue');
    expect(classifyPixel(190, 225, 235)).toBe('blue'); // pale wash still counts
    expect(classifyPixel(90, 150, 100)).toBe('green');
    expect(classifyPixel(220, 130, 60)).toBe('warm');
    expect(classifyPixel(235, 175, 165)).toBe('pink');
    expect(classifyPixel(90, 40, 110)).toBe('pink'); // plum / violet
    expect(classifyPixel(160, 125, 90)).toBe('earth');
    expect(classifyPixel(10, 10, 10)).toBe('mono');
    expect(classifyPixel(120, 120, 120)).toBe('mono');
  });
});

describe('analyseColours', () => {
  it('ignores paper and reports shares of the rest', () => {
    const buf = [...solid([255, 255, 255], 700), ...solid([30, 60, 140], 200), ...solid([90, 150, 100], 100)];
    const a = analyseColours(buf);
    expect(a.counted).toBe(300);
    expect(a.shares.blue).toBeCloseTo(2 / 3);
    expect(a.colours).toEqual(['blue', 'green']);
  });

  it('does not let thin black ink lines make a painting "mono"', () => {
    const buf = [...solid([30, 60, 140], 800), ...solid([10, 10, 10], 100)];
    expect(analyseColours(buf).colours).toEqual(['blue']);
  });

  it('tags genuinely dark work as mono', () => {
    const buf = [...solid([10, 10, 10], 600), ...solid([30, 60, 140], 100)];
    expect(analyseColours(buf).colours).toEqual(['mono']);
  });

  it('caps the suggestion at two families', () => {
    const buf = [...solid([30, 60, 140], 300), ...solid([90, 150, 100], 300), ...solid([220, 130, 60], 300)];
    expect(analyseColours(buf).colours).toHaveLength(2);
  });

  it('falls back to the strongest family when none reaches the threshold', () => {
    const buf = [
      ...solid([30, 60, 140], 14),
      ...solid([90, 150, 100], 14),
      ...solid([220, 130, 60], 14),
      ...solid([235, 175, 165], 14),
      ...solid([160, 125, 90], 14),
      ...solid([120, 120, 120], 30),
    ];
    // mono holds 30% (below its 40% bar); every other family is 14% — the strongest still wins.
    expect(analyseColours(buf).colours).toHaveLength(1);
  });

  it('returns nothing for an all-paper image', () => {
    expect(analyseColours(solid([255, 255, 255], 100)).colours).toEqual([]);
  });

  it('skips fully transparent pixels in RGBA input', () => {
    const rgba = [30, 60, 140, 255, 90, 150, 100, 0];
    expect(analyseColours(rgba, 4).counted).toBe(1);
  });
});
