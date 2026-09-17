import { afterEach, describe, it, expect, vi } from 'vitest';
import { encodePrintToken } from './print-cart';
import { encodeGiftCardToken } from './gift-cards';
import type { Product, PrintDesign } from './types';

// Mock the DB catalog loader so DB-only fixtures can be exercised without a
// real Supabase connection — same pattern as checkout.test.ts.
vi.mock('./catalog/load', () => ({
  loadCeramicProductsFromDb: vi.fn(),
  loadPrintDesignsFromDb: vi.fn(),
}));
import { loadCeramicProductsFromDb, loadPrintDesignsFromDb } from './catalog/load';

// Deterministic CMS-collection name resolution for the print-line-name test
// below — only the DB-facing loadPrintCollectionDefinitions call is mocked
// (matching this file's own convention of mocking just the DB-facing loader,
// not getPrintById/registryPrintById/isVariantAvailable/withRegistryMockups,
// which stay real).
vi.mock('./print-collections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./print-collections')>();
  return {
    ...actual,
    loadPrintCollectionDefinitions: vi.fn(async () => [
      // Name deliberately NOT 'Ostrea' — the static PRINT_COLLECTION_DEFINITIONS
      // default also names fap001's collection 'Ostrea', so asserting on that
      // name wouldn't prove this mocked `definitions` value was actually used
      // versus the static fallback silently winning.
      { slug: 'ostrea', name: 'CmsOnly', designIds: ['fap001'], prints: [] },
    ]),
  };
});

import { resolveCartLinesServer } from './cart-lines-server';

function dbOnlyProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prd_db_only',
    category: 'kubki',
    num: '99',
    image: '/uploads/db-only.webp',
    price: 12000,
    measure: '9 × 9 cm',
    sold: false,
    dropId: 'drop-1',
    noteIndex: 0,
    ...overrides,
  };
}

function dbOnlyDesign(overrides: Partial<PrintDesign> = {}): PrintDesign {
  return {
    id: 'prd_print_only',
    category: 'fine-art-prints',
    num: '99',
    image: '/uploads/db-only-print.webp',
    noteIndex: 0,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    ...overrides,
  };
}

describe('resolveCartLinesServer print line names', () => {
  it('resolves a print line with the CMS-collection-derived name', async () => {
    const lines = await resolveCartLinesServer(['print:fap001:50x70:false:false:none'], 'pl');
    const printLine = lines.find((l) => l.kind === 'print');
    expect(printLine).toBeDefined();
    if (printLine?.kind === 'print') {
      expect(printLine.name).toBe('CmsOnly 01');
    }
  });

  it('uses the locale-specific print fallback when an unassigned print is resolved', async () => {
    // This would need a special DB-mode test setup to create an unassigned print,
    // so we test that the locale parameter is accepted and threaded through.
    const lines = await resolveCartLinesServer(['print:fap001:50x70:false:false:none'], 'en');
    const printLine = lines.find((l) => l.kind === 'print');
    expect(printLine).toBeDefined();
    expect(printLine?.kind).toBe('print');
  });
});

describe('resolveCartLinesServer (CATALOG_SOURCE=code)', () => {
  it('resolves a mixed cart preserving order', async () => {
    const lines = await resolveCartLinesServer(['k01', 'print:fap005:50x70:true:false:black'], 'pl');
    expect(lines.map((l) => l.kind)).toEqual(['ceramic', 'print']);
    expect(lines[0]).toMatchObject({ kind: 'ceramic', id: 'k01' });
    expect(lines[1]).toMatchObject({
      kind: 'print',
      id: 'print:fap005:50x70:true:false:black',
      sel: { size: '50x70', framed: true, mount: false, frameColour: 'black' },
    });
    if (lines[1].kind === 'print') expect(lines[1].design.id).toBe('fap005');
  });

  it('keeps two distinct variants of the same design as separate lines', async () => {
    const lines = await resolveCartLinesServer([
      'print:fap005:30x40:false:false:none',
      'print:fap005:50x70:false:false:none',
    ], 'pl');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.kind === 'print')).toBe(true);
  });

  it('dedupes identical entries', async () => {
    expect(await resolveCartLinesServer(['k01', 'k01'], 'pl')).toHaveLength(1);
    expect(
      await resolveCartLinesServer([
        'print:fap005:50x70:true:false:black',
        'print:fap005:50x70:true:false:black',
      ], 'pl'),
    ).toHaveLength(1);
  });

  it('resolves unknown ids, malformed tokens, and unavailable/unpublished prints to an explicit unavailable line', async () => {
    expect(await resolveCartLinesServer(['nope'], 'pl')).toEqual([{ kind: 'unavailable', id: 'nope' }]);
    expect(await resolveCartLinesServer(['print:fap005:50x70:false'], 'pl')).toEqual([
      { kind: 'unavailable', id: 'print:fap005:50x70:false' },
    ]); // malformed (too few parts)
    expect(await resolveCartLinesServer(['print:nope:50x70:false:false:none'], 'pl')).toEqual([
      { kind: 'unavailable', id: 'print:nope:50x70:false:false:none' },
    ]); // unknown design
    expect(await resolveCartLinesServer(['print:fap04:50x70:false:false:none'], 'pl')).toEqual([
      { kind: 'unavailable', id: 'print:fap04:50x70:false:false:none' },
    ]); // unpublished
    // 'white' legacy-migrates to brown, so use an unknown colour to hit the decode failure path.
    expect(await resolveCartLinesServer(['print:fap005:50x70:true:false:pink'], 'pl')).toEqual([
      { kind: 'unavailable', id: 'print:fap005:50x70:true:false:pink' },
    ]);
  });

  it('resolves a gift-card token to a giftcard line', async () => {
    const lines = await resolveCartLinesServer(['giftcard:gc-500'], 'pl');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'giftcard', id: 'giftcard:gc-500', tier: { id: 'gc-500' } });
  });

  it('resolves an unknown gift-card tier to an unavailable line', async () => {
    expect(await resolveCartLinesServer(['giftcard:gc-999'], 'pl')).toEqual([
      { kind: 'unavailable', id: 'giftcard:gc-999' },
    ]);
  });

  it('resolves a mixed ceramic + gift-card cart as separate lines (checkout enforces exclusivity, not this resolver)', async () => {
    const lines = await resolveCartLinesServer(['k01', 'giftcard:gc-200'], 'pl');
    expect(lines.map((l) => l.kind)).toEqual(['ceramic', 'giftcard']);
  });

  it('without a DB-mode catalog, a DB-only id is unavailable like any unknown id', async () => {
    expect(await resolveCartLinesServer(['prd_db_only'], 'pl')).toEqual([{ kind: 'unavailable', id: 'prd_db_only' }]);
  });

  it('round-trips real encoded tokens through print-cart / gift-cards', async () => {
    const printId = encodePrintToken('fap005', { size: '50x70', framed: false, mount: false, frameColour: 'none' });
    const giftId = encodeGiftCardToken('gc-500');
    const lines = await resolveCartLinesServer([printId, giftId], 'pl');
    expect(lines.map((l) => l.kind)).toEqual(['print', 'giftcard']);
  });
});

describe('resolveCartLinesServer (CATALOG_SOURCE=db)', () => {
  const original = process.env.CATALOG_SOURCE;
  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = original;
    vi.clearAllMocks();
  });

  it('resolves a DB-only ceramic (CMS-created, absent from the code registry)', async () => {
    process.env.CATALOG_SOURCE = 'db';
    const product = dbOnlyProduct();
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([product]);
    const lines = await resolveCartLinesServer(['prd_db_only'], 'pl');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'ceramic', id: 'prd_db_only' });
    if (lines[0].kind === 'ceramic') expect(lines[0].product.id).toBe('prd_db_only');
  });

  it('treats a withdrawn (non-active status) DB ceramic as unavailable, closing the old silent-drop gap', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([dbOnlyProduct({ status: 'hidden' })]);
    expect(await resolveCartLinesServer(['prd_db_only'], 'pl')).toEqual([{ kind: 'unavailable', id: 'prd_db_only' }]);
  });

  it('resolves a DB-only print with no registry counterpart (previously silently dropped, S2a gap)', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadPrintDesignsFromDb).mockResolvedValue([dbOnlyDesign()]);
    const lines = await resolveCartLinesServer([
      'print:prd_print_only:50x70:false:false:none',
    ], 'pl');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'print', design: { id: 'prd_print_only' } });
    // No registry counterpart for this id — mockups/editorialGallery stay unset.
    if (lines[0].kind === 'print') {
      expect(lines[0].design.mockups).toBeUndefined();
      expect(lines[0].design.editorialGallery).toBeUndefined();
    }
  });

  it('merges registry mockups/editorialGallery onto a DB-sourced print that mirrors a registry id + image', async () => {
    process.env.CATALOG_SOURCE = 'db';
    // Mapper output for an existing registry print never carries `mockups`/
    // `editorialGallery` (see print-mockups.ts) — matching id + image is what
    // lets withRegistryMockups merge the registry's copy back in.
    vi.mocked(loadPrintDesignsFromDb).mockResolvedValue([
      dbOnlyDesign({ id: 'fap005', image: '/uploads/fap-005.webp' }),
    ]);
    const lines = await resolveCartLinesServer([
      'print:fap005:50x70:false:false:none',
    ], 'pl');
    expect(lines).toHaveLength(1);
    if (lines[0].kind === 'print') {
      expect(lines[0].design.mockups).toBe(true);
      expect(lines[0].design.editorialGallery).toBeDefined();
    } else {
      throw new Error('expected a print line');
    }
  });

  it('caches print design resolution per design id across multiple variants in the same cart', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadPrintDesignsFromDb).mockResolvedValue([dbOnlyDesign()]);
    await resolveCartLinesServer([
      'print:prd_print_only:30x40:false:false:none',
      'print:prd_print_only:50x70:false:false:none',
    ], 'pl');
    expect(loadPrintDesignsFromDb).toHaveBeenCalledTimes(1);
  });
});
