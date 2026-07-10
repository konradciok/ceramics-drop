import { describe, it, expect } from 'vitest';
import { registryProducts } from '../products';
import { PRINT_DESIGNS, isVariantAvailable } from '../prints';
import { PRODIGI_SKU_MAP } from '../print-cart';
import { priceOfVariant } from '../print-pricing';
import { buildCatalogSeed, enumeratePrintVariants } from './seed';
import { mapCeramicProducts, mapPrintDesigns } from './mappers';

/**
 * Parity canary: the DB-backed catalogue (backfilled from the code registry) must
 * reproduce the registry exactly. This runs against the pure seed builder + mappers
 * — the SAME code the backfill upserts and the Stage 3 storefront read will use —
 * so it guards the migration without needing a live database. It MUST stay green
 * before any storefront accessor is flipped onto the DB.
 */
describe('catalog seed ↔ registry parity', () => {
  const seed = buildCatalogSeed();

  it('round-trips ceramics back to registryProducts() exactly', () => {
    const rebuilt = mapCeramicProducts(seed.products, seed.media);
    expect(rebuilt).toEqual(registryProducts());
  });

  it('round-trips print designs back to PRINT_DESIGNS exactly (incl. drafts)', () => {
    const rebuilt = mapPrintDesigns(seed.products, seed.variants, seed.media);
    expect(rebuilt).toEqual(PRINT_DESIGNS);
  });

  it('registry print designs do not use unavailable/prices until mapper support (Stage 5)', () => {
    for (const d of PRINT_DESIGNS) {
      expect(d.unavailable, d.id).toBeUndefined();
      expect(d.prices, d.id).toBeUndefined();
    }
  });

  it('excludes inactive variants from axis recovery on published designs only', () => {
    const variants = seed.variants.map((v) =>
      v.product_id === 'fap01' && v.axes?.size === '70x100' ? { ...v, active: false } : v,
    );
    const rebuilt = mapPrintDesigns(seed.products, variants, seed.media);
    const fap01 = rebuilt.find((d) => d.id === 'fap01');
    expect(fap01?.sizes).toEqual(['30x40', '50x70']);
    const fap04 = rebuilt.find((d) => d.id === 'fap04');
    expect(fap04).toEqual(PRINT_DESIGNS.find((d) => d.id === 'fap04'));
  });

  it('emits one product row per ceramic piece (the 125-count contract)', () => {
    const ceramics = seed.products.filter((p) => p.type === 'ceramic');
    expect(ceramics).toHaveLength(125);
    expect(ceramics).toHaveLength(registryProducts().length);
  });

  it('emits one product row per print design (published and draft)', () => {
    const prints = seed.products.filter((p) => p.type === 'print');
    expect(prints).toHaveLength(PRINT_DESIGNS.length);
    // Unpublished designs land as drafts, published as active.
    expect(prints.find((p) => p.id === 'fap04')?.status).toBe('draft');
    expect(prints.find((p) => p.id === 'fap01')?.status).toBe('active');
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

  it('emits only sellable, correctly-priced variants for published designs', () => {
    const byId = new Map(PRINT_DESIGNS.map((d) => [d.id, d]));
    const publishedIds = new Set(PRINT_DESIGNS.filter((d) => d.published).map((d) => d.id));
    const publishedVariants = seed.variants.filter(
      (v) => v.axes !== null && publishedIds.has(v.product_id),
    );
    expect(publishedVariants.length).toBeGreaterThan(0);
    for (const v of publishedVariants) {
      const design = byId.get(v.product_id)!;
      // Matches the exact sellability rule checkout.ts / cart-lines.ts enforce.
      expect(isVariantAvailable(design, v.axes!), v.variant_key).toBe(true);
      // Prices are derived from print-pricing.ts and must stay in lockstep with it.
      expect(v.price_pln, v.variant_key).toBe(priceOfVariant(design, v.axes!, 'pln'));
      expect(v.price_eur, v.variant_key).toBe(priceOfVariant(design, v.axes!, 'eur'));
      expect(v.price_gbp, v.variant_key).toBe(priceOfVariant(design, v.axes!, 'gbp'));
    }
  });

  it('enumerates the expected variant count per design', () => {
    const fap01 = PRINT_DESIGNS.find((d) => d.id === 'fap01')!;
    const fap02 = PRINT_DESIGNS.find((d) => d.id === 'fap02')!;
    // fap01/fap03: 3 sizes × (1 unframed + 3 colours × 2 mount states) = 21.
    expect(enumeratePrintVariants(fap01)).toHaveLength(21);
    // fap02: 2 sizes × (1 unframed + 2 colours, no mount) = 6.
    expect(enumeratePrintVariants(fap02)).toHaveLength(6);
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
