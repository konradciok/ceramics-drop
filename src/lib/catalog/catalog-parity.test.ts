import { describe, it, expect } from 'vitest';
import { registryProducts } from '../products';
import {
  PRINT_DESIGNS,
  PRINT_DESIGNS_RAW,
  isVariantAvailable,
  registryPrintById,
  registryPrintDesigns,
} from '../prints';
import { MOUNT_TEMPORARILY_DISABLED } from '../print-availability';
import { withRegistryMockups } from '../print-mockups';
import { assetPxFor, PRODIGI_SKU_MAP } from '../print-cart';
import { DEFAULT_PRINT_PRICING, priceOfVariant } from '../print-pricing';
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
    // `mockups` and `editorialGallery` are code-bundle truth, never DB truth:
    // the WebPs ship in the bundle, the mapper doesn't carry either field, and
    // PrintProductScreen re-merges both from the code registry (guarded on
    // image parity). The DB round-trip is therefore exact modulo those two.
    expect(rebuilt).toEqual(
      PRINT_DESIGNS.map((d) => {
        const design = { ...d };
        delete design.mockups;
        delete design.editorialGallery;
        return design;
      }),
    );
  });

  it('re-merging the registry mockups flag restores FULL registry parity (the PDP render path)', () => {
    // Closes the loop the previous test opens: mapper output + the exact
    // compensation PrintProductScreen applies (withRegistryMockups against
    // registryPrintById) must reproduce the registry with no modulo at all.
    const rebuilt = mapPrintDesigns(seed.products, seed.variants, seed.media);
    expect(rebuilt.map((d) => withRegistryMockups(d, registryPrintById(d.id)))).toEqual(PRINT_DESIGNS);
  });

  it('registry print designs do not use unavailable until mapper support (Stage 5)', () => {
    for (const d of PRINT_DESIGNS) {
      expect(d.unavailable, d.id).toBeUndefined();
    }
  });

  it('excludes inactive variants from axis recovery on published designs only', () => {
    const variants = seed.variants.map((v) =>
      v.product_id === 'fap005' && v.axes?.size === '70x100' ? { ...v, active: false } : v,
    );
    const rebuilt = mapPrintDesigns(seed.products, variants, seed.media);
    const fap005 = rebuilt.find((d) => d.id === 'fap005');
    expect(fap005?.sizes).toEqual(['30x40', '50x70']);
    // mockups + editorialGallery are code-bundle truth, never DB truth (see
    // the round-trip test above) — strip them before comparing the mapper's
    // reconstruction.
    const fap033 = rebuilt.find((d) => d.id === 'fap033');
    const registryFap033 = { ...PRINT_DESIGNS.find((d) => d.id === 'fap033') };
    delete registryFap033.mockups;
    delete registryFap033.editorialGallery;
    expect(fap033).toEqual(registryFap033);
  });

  it('emits one product row per ceramic piece (the 125-count contract)', () => {
    const ceramics = seed.products.filter((p) => p.type === 'ceramic');
    expect(ceramics).toHaveLength(125);
    expect(ceramics).toHaveLength(registryProducts().length);
  });

  it('projects all 41 stable print rows into the approved active and archived catalogue state', () => {
    const printRows = seed.products.filter((p) => p.type === 'print');
    const printRowsById = new Map(printRows.map((row) => [row.id, row]));
    const activeRows = printRows
      .filter((row) => row.status === 'active')
      .sort((a, b) => a.num.localeCompare(b.num));

    expect(printRows).toHaveLength(41);
    expect(activeRows).toHaveLength(39);
    expect(activeRows.map((row) => row.num)).toEqual(
      Array.from({ length: 39 }, (_, index) => String(index + 1).padStart(2, '0')),
    );
    expect(printRowsById.get('fap029')).toMatchObject({ num: '029', status: 'archived' });
    expect(printRowsById.get('fap037')).toMatchObject({ num: '037', status: 'archived' });
    for (const archivedId of ['fap029', 'fap037']) {
      const variants = seed.variants.filter((variant) => variant.product_id === archivedId);
      expect(variants.length, archivedId).toBeGreaterThan(0);
      expect(variants.every((variant) => !variant.active), archivedId).toBe(true);
      expect(seed.media.some((media) => media.product_id === archivedId && media.is_primary), archivedId).toBe(true);
    }

    const rebuiltActive = mapPrintDesigns(activeRows, seed.variants, seed.media);
    expect(rebuiltActive.map((design) => design.id)).toEqual(
      registryPrintDesigns().map((design) => design.id),
    );
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

  it('seeds per-variant print-area pixels from PRODIGI_SKU_MAP (null for ceramics)', () => {
    // Ceramics carry no print-area contract.
    for (const v of seed.variants.filter((v) => v.axes === null)) {
      expect(v.print_area_width_px, v.product_id).toBeNull();
      expect(v.print_area_height_px, v.product_id).toBeNull();
    }
    // Every enumerated print variant is structurally valid (enumeratePrintVariants
    // excludes only design.unavailable keys), so each must resolve in the SKU map
    // and carry its exact print-area pixels — the contract publish_print_asset_revision enforces.
    const printVariants = seed.variants.filter((v) => v.axes !== null);
    expect(printVariants.length).toBeGreaterThan(0);
    for (const v of printVariants) {
      const mapped = PRODIGI_SKU_MAP[v.variant_key];
      expect(mapped, v.variant_key).toBeDefined();
      const assetPx = assetPxFor(mapped);
      expect(v.print_area_width_px, v.variant_key).toBe(assetPx.w);
      expect(v.print_area_height_px, v.variant_key).toBe(assetPx.h);
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
      // While passe-partout is temporarily withdrawn (print-availability.ts) the
      // seed still emits mount rows — deliberately seeded-but-unsellable, so the
      // DB is unchanged and the switch flips back with no backfill.
      expect(isVariantAvailable(design, v.axes!), v.variant_key).toBe(
        MOUNT_TEMPORARILY_DISABLED ? !v.axes!.mount : true,
      );
      // Seed prices derive from DEFAULT_PRINT_PRICING (buildCatalogSeed's default
      // arg) and must stay in lockstep with it. These shadow columns are read by
      // nobody at runtime — live pricing comes from getPrintPricingConfig().
      expect(v.price_pln, v.variant_key).toBe(priceOfVariant(v.axes!, 'pln', DEFAULT_PRINT_PRICING));
      expect(v.price_eur, v.variant_key).toBe(priceOfVariant(v.axes!, 'eur', DEFAULT_PRINT_PRICING));
      expect(v.price_gbp, v.variant_key).toBe(priceOfVariant(v.axes!, 'gbp', DEFAULT_PRINT_PRICING));
    }
  });

  it('enumerates the expected variant count per design', () => {
    // The 2026-08-17 print-001..041 batch has no mount-crop source at all, so
    // mountAvailable is false as RAW truth (not just read-gated) for every
    // design — unlike the full-axes policy the prior batch's registry carried.
    // 3 sizes × (1 unframed + 3 colours × 1 no-mount state) = 12.
    for (const d of PRINT_DESIGNS_RAW) {
      expect(enumeratePrintVariants(d), d.id).toHaveLength(12);
    }
  });

  it.runIf(MOUNT_TEMPORARILY_DISABLED)('enumerates 12 mount-free variants off the gated registry', () => {
    // The storefront-facing registry drops the 9 mounted variants per design:
    // 3 sizes × (1 unframed + 3 colours) = 12. Proves the gate reaches the shared
    // enumerator, and that only the seed is exempt from it.
    for (const d of PRINT_DESIGNS) {
      expect(enumeratePrintVariants(d), d.id).toHaveLength(12);
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
