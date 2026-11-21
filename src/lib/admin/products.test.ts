import { describe, expect, it } from 'vitest';
import { productRef } from './products';

describe('productRef', () => {
  it('resolves ceramic products', () => {
    const ref = productRef('k01');
    expect(ref.known).toBe(true);
    expect(ref.label).toBe('Kubek Nº01');
    expect(ref.category).toBe('kubki');
  });

  it('resolves print products with variant label', () => {
    const ref = productRef('fap005', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    expect(ref.known).toBe(true);
    expect(ref.label).toContain('Signs 02');
    expect(ref.label).toContain('50×70 cm');
    expect(ref.category).toBe('fine-art-prints');
  });

  it('labels a legacy print id from the frozen name table, with no thumbnail', () => {
    const ref = productRef('fap001');
    expect(ref).toEqual({
      id: 'fap001',
      label: 'Ostrea 01',
      category: 'fine-art-prints',
      image: null,
      known: true,
    });
  });

  it('degrades unknown ids', () => {
    const ref = productRef('missing-piece');
    expect(ref.known).toBe(false);
    expect(ref.label).toBe('missing-piece');
  });
});
