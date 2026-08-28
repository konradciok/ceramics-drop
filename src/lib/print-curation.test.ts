import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PRINT_CURATION,
  PRINT_COLLECTION_DEFINITIONS,
  PRINT_CURATION,
  RETIRED_PRINT_CURATION,
  catalogStatusForPrint,
  curationForProduct,
} from './print-curation';

describe('fine-art print curation map', () => {
  it('preserves the authored collection and numbering invariants', () => {
    expect(PRINT_COLLECTION_DEFINITIONS.map(({ name }) => name)).toEqual([
      'Ostrea', 'Gestures', 'Linea', 'Horizons', 'Portals',
      'Signs', 'Ciala', 'Balance', 'Verticles',
    ]);
    expect(ACTIVE_PRINT_CURATION.map(({ number }) => number)).toEqual(
      Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
    expect(PRINT_COLLECTION_DEFINITIONS.every(({ prints }) => prints.length >= 4 && prints.length <= 5)).toBe(true);
    expect(RETIRED_PRINT_CURATION.map(({ productId }) => productId)).toEqual(['fap029', 'fap037']);

    for (const item of PRINT_CURATION) {
      expect(item.productId).toBe(`fap${item.sourceNumber}`);
    }
    expect(new Set(PRINT_CURATION.map((item) => item.productId)).size).toBe(41);
    expect(new Set(ACTIVE_PRINT_CURATION.map((item) => item.number)).size).toBe(39);
    for (const retired of RETIRED_PRINT_CURATION) {
      expect(ACTIVE_PRINT_CURATION.some((item) => item.productId === retired.duplicateOf)).toBe(true);
    }
  });

  it('projects active and retired lookup behavior', () => {
    expect(curationForProduct('fap041')?.number).toBe('13');
    expect(curationForProduct('fap029')).toBeUndefined();
    expect(curationForProduct('unknown')).toBeUndefined();
    expect(catalogStatusForPrint('fap041')).toBe('active');
    expect(catalogStatusForPrint('fap029')).toBe('archived');
    expect(() => catalogStatusForPrint('unknown')).toThrow(/unknown print/i);
  });
});
