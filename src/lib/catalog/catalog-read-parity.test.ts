import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getProducts,
  getProductById,
  getProductsByCategory,
  registryProducts,
} from '../products';
import { getPrintById, getPrintDesigns, registryPrintDesigns } from '../prints';
import { buildCatalogSeed } from './seed';
import { mapCeramicProducts, mapPrintDesigns, sortCeramicProductRows } from './mappers';
import { catalogSource } from './source';

/**
 * Accessor-level parity gate for the Stage 3b flip: repository ordering and the
 * CATALOG_SOURCE flag must match registry semantics before the storefront flips.
 */
describe('catalog read path ↔ registry parity', () => {
  const seed = buildCatalogSeed();

  it('recovers CATEGORY_ORDER from alphabetical DB row order', () => {
    const ceramics = seed.products.filter((p) => p.type === 'ceramic');
    const dbOrder = [...ceramics].sort((a, b) => {
      const byCat = a.category_slug.localeCompare(b.category_slug);
      return byCat !== 0 ? byCat : a.num.localeCompare(b.num, undefined, { numeric: true });
    });
    expect(dbOrder[0]?.id).not.toBe(registryProducts()[0]?.id);
    expect(mapCeramicProducts(sortCeramicProductRows(dbOrder), seed.media)).toEqual(registryProducts());
  });
});

describe('catalogSource', () => {
  const original = process.env.CATALOG_SOURCE;
  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = original;
  });

  it("defaults to 'code' when unset or not exactly 'db'", () => {
    delete process.env.CATALOG_SOURCE;
    expect(catalogSource()).toBe('code');
    process.env.CATALOG_SOURCE = 'registry';
    expect(catalogSource()).toBe('code');
  });

  it("returns 'db' only for the exact string 'db'", () => {
    process.env.CATALOG_SOURCE = 'db';
    expect(catalogSource()).toBe('db');
  });
});

/* ============================================================
   End-to-end flip gate: drive the PUBLIC async accessors with
   CATALOG_SOURCE='db', proving the async wrappers + the dynamic DB read path
   reproduce the registry exactly. The DB load module is mocked to return the
   mapper output for the backfill seed (i.e. what a backfilled Supabase would
   yield), so this needs no live database — the same guard the mapper parity
   test gives, but exercised THROUGH getProducts()/getPrintDesigns() rather than
   the mappers alone.
   ============================================================ */
vi.mock('./load', () => ({
  loadCeramicProductsFromDb: vi.fn(),
  loadPrintDesignsFromDb: vi.fn(),
}));
import { loadCeramicProductsFromDb, loadPrintDesignsFromDb } from './load';

describe('async accessors under CATALOG_SOURCE=db', () => {
  const seed = buildCatalogSeed();
  // DB-derived shapes = exactly what the repository readers reconstruct from a
  // backfilled catalogue (mapper output on the seed rows).
  const dbCeramics = mapCeramicProducts(sortCeramicProductRows(seed.products), seed.media);
  const dbPrints = mapPrintDesigns(seed.products, seed.variants, seed.media);
  const original = process.env.CATALOG_SOURCE;

  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = original;
    vi.clearAllMocks();
  });

  it('getProducts()/byId/byCategory deep-equal the registry via the DB path', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue(dbCeramics);

    expect(await getProducts()).toEqual(registryProducts());
    expect(await getProductById('k01')).toEqual(registryProducts().find((p) => p.id === 'k01'));
    expect(await getProductById('nope')).toBeUndefined();
    expect((await getProductsByCategory('kubki')).map((p) => p.id)).toEqual(
      registryProducts().filter((p) => p.category === 'kubki').map((p) => p.id),
    );
    // The DB branch was actually taken (not the registry short-circuit).
    expect(loadCeramicProductsFromDb).toHaveBeenCalled();
  });

  it('getPrintDesigns()/getPrintById() deep-equal the registry via the DB path', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadPrintDesignsFromDb).mockResolvedValue(dbPrints);

    // getPrintDesigns filters to published, in num order — must equal the registry helper.
    expect(await getPrintDesigns()).toEqual(registryPrintDesigns());
    // getPrintById resolves drafts too (checkout needs to reject hidden vs unknown).
    expect((await getPrintById('fap04'))?.published).toBe(false);
    expect(await getPrintById('unknown')).toBeUndefined();
    expect(loadPrintDesignsFromDb).toHaveBeenCalled();
  });
});
