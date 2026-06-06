import { describe, it, expect } from 'vitest';
import { IMG_WIDTHS, srcSet, smallest } from './images';

describe('images helpers', () => {
  it('IMG_WIDTHS matches optimize-images.mjs', () => {
    expect(IMG_WIDTHS).toEqual([400, 800, 1600]);
  });

  it('smallest returns the 400w variant path', () => {
    expect(smallest('/uploads/kubek-2.webp')).toBe('/uploads/kubek-2-400w.webp');
  });

  it('srcSet returns all three width descriptors', () => {
    const result = srcSet('/uploads/kubek-2.webp');
    expect(result).toBe(
      '/uploads/kubek-2-400w.webp 400w, /uploads/kubek-2-800w.webp 800w, /uploads/kubek-2-1600w.webp 1600w',
    );
  });

  it('srcSet handles paths with hyphens in the stem', () => {
    const result = srcSet('/uploads/waza-mala-1.webp');
    expect(result).toContain('/uploads/waza-mala-1-400w.webp 400w');
    expect(result).toContain('/uploads/waza-mala-1-1600w.webp 1600w');
  });
});
