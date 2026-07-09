import { describe, it, expect } from 'vitest';
import { getProducts } from '../products';
import { PRINT_DESIGNS } from '../prints';
import { PRODIGI_SKU_MAP } from '../print-cart';
import { buildCatalogSeed, enumeratePrintVariants } from './seed';
import { mapCeramicProducts } from './mappers';

/**
 * Parity canary: the DB-backed catalogue (backfilled from the code registry) must
 * reproduce the registry exactly. This runs against the pure seed builder + mappers
 * — the SAME code the backfill upserts and the Stage 3 storefront read will use —
 * so it guards the migration without needing a live database. It MUST stay green
 * before any storefront accessor is flipped onto the DB.
 */
describe('catalog seed ↔ registry parity', () => {
  const seed = buildCatalogSeed();

  it('round-trips ceramics back to getProducts() exactly', () => {
    const rebuilt = mapCeramicProducts(seed.products, seed.media);
    expect(rebuilt).toEqual(getProducts());
  });

  it('emits one product row per ceramic piece (the 125-count contract)', () => {
    const ceramics = seed.products.filter((p) => p.type === 'ceramic');
    expect(ceramics).toHaveLength(125);
    expect(ceramics).toHaveLength(getProducts().length);
  });

  it('emits one product row per print design (published and draft)', () => {
    const prints = seed.products.filter((p) => p.type === 'print');
    expect(prints).toHaveLength(PRINT_DESIGNS.length);
    // Unpublished designs land as drafts, published as active.
    expect(prints.find((p) => p.id === 'fap04')?.status).toBe('draft');
    expect(prints.find((p) => p.id === 'fap01')?.status).toBe('active');
  });

  it('gives every ceramic a single default variant tracked at qty 1', () => {
    for (const p of getProducts()) {
      const variants = seed.variants.filter((v) => v.product_id === p.id);
      expect(variants, p.id).toHaveLength(1);
      expect(variants[0]).toMatchObject({
        variant_key: 'default',
        is_default: true,
        track_inventory: true,
        stock_quantity: 1,
        allow_backorder: false,
      });
    }
  });

  it('maps every print variant to a known Prodigi SKU', () => {
    const printVariants = seed.variants.filter((v) => v.axes !== null);
    expect(printVariants.length).toBeGreaterThan(0);
    for (const v of printVariants) {
      expect(v.sku, v.variant_key).not.toBeNull();
      expect(PRODIGI_SKU_MAP[v.variant_key]?.sku, v.variant_key).toBe(v.sku);
      expect(v.track_inventory).toBe(false); // POD
      expect(v.allow_backorder).toBe(true);
    }
  });

  it('enumerates the expected variant count per design', () => {
    // fap01/fap03: 3 sizes × (1 unframed + 3 colours × 2 mount states) = 21.
    expect(enumeratePrintVariants(PRINT_DESIGNS[0])).toHaveLength(21); // fap01
    // fap02: 2 sizes × (1 unframed + 2 colours, no mount) = 6.
    expect(enumeratePrintVariants(PRINT_DESIGNS[1])).toHaveLength(6); // fap02
  });

  it('marks exactly one primary image per product and preserves galleries', () => {
    const primaries = seed.media.filter((m) => m.is_primary);
    const productIds = new Set(seed.products.map((p) => p.id));
    // One primary per product.
    expect(primaries).toHaveLength(productIds.size);
    // Spot-check known image mappings.
    expect(seed.media.find((m) => m.product_id === 'k01' && m.is_primary)?.url).toBe(
      '/uploads/kubek-1.webp',
    );
    // w12 carries a merged second photo (gallery).
    const w12 = seed.media.filter((m) => m.product_id === 'w12');
    expect(w12.find((m) => !m.is_primary)?.url).toBe('/uploads/miski-falowane-11.webp');
  });
});
