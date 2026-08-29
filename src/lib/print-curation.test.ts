import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PRINT_CURATION,
  PRINT_COLLECTION_DEFINITIONS,
  PRINT_CURATION,
  RETIRED_PRINT_CURATION,
  catalogStatusForPrint,
  curationForProduct,
  validatePrintCuration,
} from './print-curation';
import source from '../../config/print-catalog-curation.json';

describe('fine-art print curation map', () => {
  it('only runs migration rollout gates when mapped product IDs exist', () => {
    const migration = readFileSync(
      new URL('../../supabase/migrations/20260828120000_curate_fine_art_prints.sql', import.meta.url),
      'utf8',
    );
    const mappedPrintPresence = String.raw`exists\s*\(\s*select 1\s+from products\s+p\s+join print_curation_map\s+mapped\s+on mapped\.id = p\.id\s*\)`;

    expect(migration).toMatch(new RegExp(`if ${mappedPrintPresence} then`));
    expect(migration).toMatch(new RegExp(`if not ${mappedPrintPresence} then\\s+return;`));
    expect(migration).not.toMatch(/if (?:not )?exists \(select 1 from products\)/);
  });

  it('keeps the migration rollout snapshot aligned with the authored curation', () => {
    const migration = readFileSync(
      new URL('../../supabase/migrations/20260828120000_curate_fine_art_prints.sql', import.meta.url),
      'utf8',
    );
    const valuesBlock = migration.match(
      /insert into print_curation_map \(id, num, status\)\s*values\s*([\s\S]*?);/,
    );
    expect(valuesBlock, 'print_curation_map INSERT must remain present').not.toBeNull();

    const migrationRows = Array.from(
      valuesBlock![1].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g),
      ([, id, num, status]) => ({ id, num, status }),
    );
    const authoredRows = [
      ...source.collections.flatMap(({ prints }) => prints.map(({ productId, number }) => ({
        id: productId,
        num: number,
        status: 'active',
      }))),
      ...source.retired.map(({ productId, sourceNumber }) => ({
        id: productId,
        num: sourceNumber,
        status: 'archived',
      })),
    ];

    expect(migrationRows).toEqual(authoredRows);
  });

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

  it('fails descriptively when exact authored invariants are malformed', () => {
    const names = structuredClone(source);
    names.collections[0].name = 'Wrong';
    expect(() => validatePrintCuration(names)).toThrow(/collection names must be exactly/i);

    const retired = structuredClone(source);
    retired.retired[0].productId = 'fap040';
    expect(() => validatePrintCuration(retired)).toThrow(/retired IDs must be exactly/i);

    const universe = structuredClone(source);
    universe.collections[0].prints[0].productId = 'fap999';
    expect(() => validatePrintCuration(universe)).toThrow(/product ID universe must be fap001 through fap041/i);
  });
});
