import { describe, it, expect, afterEach } from 'vitest';
import { getProducts } from '../products';
import { PRINT_DESIGNS } from '../prints';
import { buildCatalogSeed } from './seed';
import { mapCeramicProducts, mapPrintDesigns } from './mappers';
import { catalogSource } from './source';

/**
 * Accessor-level parity gate for the Stage 3b flip: the DB read path
 * (mappers over the backfill seed rows — the same rows the DB holds) must
 * reconstruct the registry EXACTLY, so flipping CATALOG_SOURCE=db is a no-op for
 * the storefront. Runs without a live DB by operating on buildCatalogSeed().
 */
describe('catalog read path ↔ registry parity', () => {
  const seed = buildCatalogSeed();

  it('reconstructs ceramics identically to getProducts()', () => {
    expect(mapCeramicProducts(seed.products, seed.media)).toEqual(getProducts());
  });

  it('reconstructs print designs identically to PRINT_DESIGNS (incl. drafts)', () => {
    const rebuilt = mapPrintDesigns(seed.products, seed.variants, seed.media);
    expect(rebuilt).toEqual(PRINT_DESIGNS);
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
