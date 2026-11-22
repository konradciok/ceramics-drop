/* ============================================================
   Catalog seed builder — code registry → DB rows
   ------------------------------------------------------------
   Pure, deterministic transform from the static ceramic registry
   (src/lib/products.ts + pricing) into the `products` /
   `product_variants` / `product_media` row shapes.

   This is the SINGLE structural source of the backfill. `backfillCatalog()`
   passes this projection to one transaction-scoped RPC, which touches only
   the ids in the seed. Fine-art prints left the registry with the print shop
   (2026-11): their DB rows are no longer seeded, so a backfill leaves them
   exactly as they are until the print-schema drop migration removes them.
   The parity test round-trips this desired projection through the mappers.
   ============================================================ */
import { registryProducts } from '../products';
import { PRICE_EUR, PRICE_GBP } from '../pricing';
import type { CatalogSeed } from './types';

function ceramicRows(seed: CatalogSeed): void {
  for (const p of registryProducts()) {
    seed.products.push({
      id: p.id,
      type: 'ceramic',
      category_slug: p.category,
      num: p.num,
      slug: null,
      // PLN honours per-product overrides (product.price); EUR/GBP are the
      // per-category tables, exactly as priceOfCurrency() resolves them today.
      price_pln: p.price,
      price_eur: PRICE_EUR[p.category],
      price_gbp: PRICE_GBP[p.category],
      sale_price_pln: null,
      sale_price_eur: null,
      sale_price_gbp: null,
      measure: p.measure,
      status: 'active',
      seo_title: null,
      seo_description: null,
      title: null,
      description: null,
      drop_id: p.dropId,
      note_index: p.noteIndex,
    });

    // One default variant, 1/1 stock.
    seed.variants.push({
      product_id: p.id,
      variant_key: 'default',
      sku: null,
      axes: null,
      price_pln: null,
      price_eur: null,
      price_gbp: null,
      is_default: true,
      active: true,
      position: 0,
      track_inventory: true,
      stock_quantity: 1,
      allow_backorder: false,
      low_stock_threshold: null,
    });

    // Primary image + gallery (in registry order).
    seed.media.push({ product_id: p.id, url: p.image, alt: null, position: 0, is_primary: true });
    (p.gallery ?? []).forEach((url, i) => {
      seed.media.push({ product_id: p.id, url, alt: null, position: i + 1, is_primary: false });
    });
  }
}

/** Build the full catalog backfill payload from the static registry. */
export function buildCatalogSeed(): CatalogSeed {
  const seed: CatalogSeed = { products: [], variants: [], media: [] };
  ceramicRows(seed);
  return seed;
}
