import { describe, it, expect } from 'vitest';
import { registryProducts } from '../products';
import { PRICE_EUR, PRICE_GBP } from '../pricing';
import { buildCatalogSeed } from './seed';
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

  it('round-trips ceramics back to registryProducts() exactly (modulo priceEur/priceGbp)', () => {
    // seed.ts backfills price_eur/price_gbp for every ceramic row from these
    // same PRICE_EUR/PRICE_GBP constants; mapCeramicProducts now surfaces them
    // (S2b — priceOfCurrency prefers the DB value). The bare registry carries
    // no such fields (they're synthesized at seed time), so the round-trip is
    // exact modulo those two.
    const rebuilt = mapCeramicProducts(seed.products, seed.media);
    expect(rebuilt).toEqual(
      registryProducts().map((p) => ({
        ...p,
        priceEur: PRICE_EUR[p.category],
        priceGbp: PRICE_GBP[p.category],
      })),
    );
  });

  it('emits one product row per ceramic piece (the 189-count contract)', () => {
    const ceramics = seed.products.filter((p) => p.type === 'ceramic');
    expect(ceramics).toHaveLength(189);
    expect(ceramics).toHaveLength(registryProducts().length);
  });

  it('seeds ceramics only — retired prints are never re-seeded', () => {
    expect(seed.products.every((p) => p.type === 'ceramic')).toBe(true);
    expect(seed.variants.every((v) => v.axes === null)).toBe(true);
  });

  it('gives every ceramic a single default variant tracked at qty 1', () => {
    for (const p of registryProducts()) {
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

  it('gives every product exactly one default variant (one-default index)', () => {
    const defaultsByProduct = new Map<string, number>();
    for (const v of seed.variants) {
      if (v.is_default) defaultsByProduct.set(v.product_id, (defaultsByProduct.get(v.product_id) ?? 0) + 1);
    }
    for (const p of seed.products) {
      expect(defaultsByProduct.get(p.id), p.id).toBe(1);
    }
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
