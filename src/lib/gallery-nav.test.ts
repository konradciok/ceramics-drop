import { describe, it, expect } from 'vitest';
import { stepGalleryIndex } from './gallery-nav';

describe('stepGalleryIndex', () => {
  it('advances by delta within bounds', () => {
    expect(stepGalleryIndex(0, 1, 4)).toBe(1);
    expect(stepGalleryIndex(1, -1, 4)).toBe(0);
  });

  it('clamps at the last index instead of wrapping', () => {
    expect(stepGalleryIndex(3, 1, 4)).toBe(3);
  });

  it('clamps at zero instead of going negative', () => {
    expect(stepGalleryIndex(0, -1, 4)).toBe(0);
  });

  it('returns 0 for a non-positive length', () => {
    expect(stepGalleryIndex(0, 1, 0)).toBe(0);
  });
});
