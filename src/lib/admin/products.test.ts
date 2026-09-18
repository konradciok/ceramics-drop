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
    expect(ref.label).toContain('Horizons 01');
    expect(ref.label).toContain('50×70 cm');
    expect(ref.category).toBe('fine-art-prints');
  });

  it('threads definitions through printDisplayName (discriminating fixture)', () => {
    // The static PRINT_COLLECTION_DEFINITIONS default maps fap005 to 'Horizons 01'.
    // This test mocks definitions with 'CmsOnly' for fap005, so asserting on the name
    // proves that the definitions parameter was actually threaded through to
    // printDisplayName, not silently dropped in favor of the static fallback.
    const discriminatingDefs = [
      { slug: 'cms-only', name: 'CmsOnly', designIds: ['fap005'], prints: [] },
    ];
    const ref = productRef('fap005', { size: '50x70', framed: true, mount: false, frameColour: 'black' }, discriminatingDefs);
    expect(ref.known).toBe(true);
    expect(ref.label).toContain('CmsOnly 01');
    expect(ref.label).not.toContain('Horizons');
    expect(ref.label).toContain('50×70 cm');
  });

  it('degrades unknown ids', () => {
    const ref = productRef('missing-piece');
    expect(ref.known).toBe(false);
    expect(ref.label).toBe('missing-piece');
  });
});
