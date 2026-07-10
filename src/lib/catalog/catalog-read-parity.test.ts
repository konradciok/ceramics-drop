import { describe, it, expect, afterEach } from 'vitest';
import { registryProducts } from '../products';
import { buildCatalogSeed } from './seed';
import { mapCeramicProducts, sortCeramicProductRows } from './mappers';
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
