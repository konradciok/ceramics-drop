import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PRINT_CURATION,
  PRINT_COLLECTION_DEFINITIONS,
  PRINT_CURATION,
  RETIRED_PRINT_CURATION,
  catalogStatusForPrint,
  curationForProduct,
  printDisplayName,
  validatePrintCuration,
} from './print-curation';
import type { PrintCollectionDefinition } from './print-curation';
import source from '../../config/print-catalog-curation.json';

describe('fine-art print curation map', () => {
  it('names every collection independently from 01 in display order', () => {
    for (const collection of PRINT_COLLECTION_DEFINITIONS) {
      collection.designIds.forEach((id, index) => {
        expect(printDisplayName({ id, num: '99' }, 'Druk')).toBe(
          `${collection.name} ${String(index + 1).padStart(2, '0')}`,
        );
      });
    }
    expect(printDisplayName({ id: 'fap004', num: '30' })).toBe('Signs 01');
    expect(printDisplayName({ id: 'fap008', num: '32' })).toBe('Ciala 01');
    expect(printDisplayName({ id: 'unknown', num: '42' }, 'Druk')).toBe('Druk Nº 42');
  });

  it('only runs migration rollout gates when mapped product IDs exist', () => {
    const migration = readFileSync(
      new URL('../../supabase/migrations/20260828120000_curate_fine_art_prints.sql', import.meta.url),
      'utf8',
    );
    const mappedPrintPresence = String.raw`exists\s*\(\s*select 1\s+from products\s+p\s+join print_curation_map\s+mapped\s+on mapped\.id = p\.id\s*\)`;

    expect(migration).toMatch(new RegExp(`if ${mappedPrintPresence} then`));
    expect(migration).toMatch(new RegExp(`if not ${mappedPrintPresence} then\\s+return;`));
    expect(migration).not.toMatch(
      /if\s+(?:not\s+)?exists\s*\(\s*select\s+1\s+from\s+products\s*\)/i,
    );
  });

  it('keeps the migration rollout snapshot unchanged since it was applied', () => {
    // supabase/migrations/20260828120000_curate_fine_art_prints.sql already
    // ran against production — its temporary print_curation_map rollout gate
    // is a frozen historical artifact of the curation authored on 2026-08-28,
    // not a live reflection of config/print-catalog-curation.json. Later
    // curation edits (e.g. the 2026-09-25 collection reshuffle) intentionally
    // diverge from it — this pins the *migration file itself* against silent
    // edits, not against `source`.
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
    const originalAuthoredRows = [
      { id: 'fap001', num: '01', status: 'active' }, { id: 'fap002', num: '02', status: 'active' },
      { id: 'fap003', num: '03', status: 'active' }, { id: 'fap006', num: '04', status: 'active' },
      { id: 'fap007', num: '05', status: 'active' }, { id: 'fap010', num: '06', status: 'active' },
      { id: 'fap012', num: '07', status: 'active' }, { id: 'fap014', num: '08', status: 'active' },
      { id: 'fap016', num: '09', status: 'active' }, { id: 'fap011', num: '10', status: 'active' },
      { id: 'fap018', num: '11', status: 'active' }, { id: 'fap036', num: '12', status: 'active' },
      { id: 'fap041', num: '13', status: 'active' }, { id: 'fap005', num: '14', status: 'active' },
      { id: 'fap023', num: '15', status: 'active' }, { id: 'fap026', num: '16', status: 'active' },
      { id: 'fap038', num: '17', status: 'active' }, { id: 'fap039', num: '18', status: 'active' },
      { id: 'fap024', num: '19', status: 'active' }, { id: 'fap027', num: '20', status: 'active' },
      { id: 'fap030', num: '21', status: 'active' }, { id: 'fap031', num: '22', status: 'active' },
      { id: 'fap032', num: '23', status: 'active' }, { id: 'fap004', num: '24', status: 'active' },
      { id: 'fap008', num: '25', status: 'active' }, { id: 'fap025', num: '26', status: 'active' },
      { id: 'fap033', num: '27', status: 'active' }, { id: 'fap019', num: '28', status: 'active' },
      { id: 'fap020', num: '29', status: 'active' }, { id: 'fap021', num: '30', status: 'active' },
      { id: 'fap034', num: '31', status: 'active' }, { id: 'fap015', num: '32', status: 'active' },
      { id: 'fap028', num: '33', status: 'active' }, { id: 'fap035', num: '34', status: 'active' },
      { id: 'fap040', num: '35', status: 'active' }, { id: 'fap009', num: '36', status: 'active' },
      { id: 'fap013', num: '37', status: 'active' }, { id: 'fap017', num: '38', status: 'active' },
      { id: 'fap022', num: '39', status: 'active' },
      { id: 'fap029', num: '029', status: 'archived' }, { id: 'fap037', num: '037', status: 'archived' },
    ];

    expect(migrationRows).toEqual(originalAuthoredRows);
  });

  it('preserves the authored collection and numbering invariants', () => {
    expect(PRINT_COLLECTION_DEFINITIONS.map(({ name }) => name)).toEqual([
      'Ostrea', 'Gestures', 'Linea', 'Horizons', 'Portals',
      'Signs', 'Ciala', 'Balance', 'Verticles',
    ]);
    expect(ACTIVE_PRINT_CURATION.map(({ number }) => number)).toEqual(
      Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
    expect(PRINT_COLLECTION_DEFINITIONS.map(({ prints }) => prints.length)).toEqual([5, 8, 9, 2, 5, 2, 2, 2, 4]);
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
    expect(curationForProduct('fap041')?.number).toBe('16');
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

describe('printDisplayName with an explicit definitions array', () => {
  it('uses the passed-in definitions instead of the static curation map', () => {
    const customDefinitions: PrintCollectionDefinition[] = [
      { slug: 'custom', name: 'Custom Collection', designIds: ['fap001', 'fap002'], prints: [] },
    ];
    // fap001 is "Ostrea 01" under the static map, but "Custom Collection 01"
    // under this explicit array — proves the parameter, not the module
    // constant, drives the result.
    expect(printDisplayName({ id: 'fap001', num: '01' }, 'Print', customDefinitions)).toBe(
      'Custom Collection 01',
    );
  });

  it('still uses the static curation map when no definitions argument is passed', () => {
    expect(printDisplayName({ id: 'fap001', num: '01' }, 'Print')).toBe('Ostrea 01');
  });
});
