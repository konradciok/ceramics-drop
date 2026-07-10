/* ============================================================
   Catalog repository — DB read/write for the product catalogue
   ------------------------------------------------------------
   Stage 0: only the idempotent backfill is exercised (shadow tables). The read
   helpers exist for the Stage 3 storefront flip and are intentionally not wired
   into any public path yet.
   ============================================================ */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PrintDesign, Product } from '../types';
import { buildCatalogSeed } from './seed';
import { mapCeramicProducts, mapPrintDesigns, sortCeramicProductRows } from './mappers';
import type { MediaSeedRow, ProductSeedRow, VariantSeedRow } from './types';

/** The catalogue rows the admin list reads (products + their variants). */
export interface CatalogRows {
  products: ProductSeedRow[];
  variants: VariantSeedRow[];
}

/**
 * Read every catalogue product + variant row. Returns empty arrays when the
 * shadow tables have not been backfilled yet — callers fall back to the code
 * registry and surface a "run catalog:backfill" hint.
 */
export async function listCatalogRows(supabase: SupabaseClient): Promise<CatalogRows> {
  const [productsRes, variantsRes] = await Promise.all([
    supabase.from('products').select('*'),
    supabase.from('product_variants').select('*'),
  ]);
  if (productsRes.error) throw new Error(`list products: ${productsRes.error.message}`);
  if (variantsRes.error) throw new Error(`list variants: ${variantsRes.error.message}`);
  return {
    products: (productsRes.data ?? []) as ProductSeedRow[],
    variants: (variantsRes.data ?? []) as VariantSeedRow[],
  };
}

/**
 * Idempotently mirror the code registry into the catalog tables.
 *
 * Products upsert on `id` (never deleted — a stable id may be referenced by
 * historical order_items even after the registry drops it). Variants and media
 * are REPLACED for the seeded products: blindly upserting them is fragile because
 * the `product_media_one_primary` / `product_variants_one_default` partial unique
 * indexes conflict when a primary image path or variant set changes between runs.
 * Deleting first (scoped to the seeded ids) makes re-runs converge cleanly.
 *
 * The three writes are not wrapped in a single transaction: for Stage 0 the tables
 * are inert (nothing reads them) and the whole op is idempotent, so a mid-way
 * failure is healed by re-running. A transactional RPC is deferred to the stage
 * that puts this on the storefront read path. This does NOT touch piece_state /
 * orders — stock and sale state stay where they are until a later stage.
 *
 * Requires migration 20260709130000 (seeds the `drop-1` row) to have run, since
 * ceramic product rows carry a `drop_id` FK to `drops`.
 */
export async function backfillCatalog(supabase: SupabaseClient): Promise<void> {
  const seed = buildCatalogSeed();
  const productIds = seed.products.map((p) => p.id);

  // Replace variants + media for the seeded products (media first — it FKs variants).
  const delMedia = await supabase.from('product_media').delete().in('product_id', productIds);
  if (delMedia.error) throw new Error(`backfill clear media: ${delMedia.error.message}`);

  const delVariants = await supabase
    .from('product_variants')
    .delete()
    .in('product_id', productIds);
  if (delVariants.error) throw new Error(`backfill clear variants: ${delVariants.error.message}`);

  const products = await supabase.from('products').upsert(seed.products, { onConflict: 'id' });
  if (products.error) throw new Error(`backfill products: ${products.error.message}`);

  const variants = await supabase.from('product_variants').insert(seed.variants);
  if (variants.error) throw new Error(`backfill variants: ${variants.error.message}`);

  const media = await supabase.from('product_media').insert(seed.media);
  if (media.error) throw new Error(`backfill media: ${media.error.message}`);
}

/**
 * Read the ceramic catalogue from the DB and reconstruct `Product[]` in
 * category → display-num order. Reserved for the Stage 3 flip; not yet called by
 * any storefront surface.
 */
export async function readCeramicProducts(supabase: SupabaseClient): Promise<Product[]> {
  const productsRes = await supabase.from('products').select('*').eq('type', 'ceramic');
  if (productsRes.error) throw new Error(`read products: ${productsRes.error.message}`);

  const rows = sortCeramicProductRows((productsRes.data ?? []) as ProductSeedRow[]);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const mediaRes = await supabase.from('product_media').select('*').in('product_id', ids);
  if (mediaRes.error) throw new Error(`read media: ${mediaRes.error.message}`);

  return mapCeramicProducts(rows, (mediaRes.data ?? []) as MediaSeedRow[]);
}

/**
 * Read the print catalogue from the DB and reconstruct `PrintDesign[]` (all
 * designs, published and draft — `getPrintById` needs the drafts too). Reserved
 * for the Stage 3b flip; not yet called by any storefront surface. Variants and
 * media are read in `position` order so the axis/gallery reconstruction is stable.
 */
export async function readPrintDesigns(supabase: SupabaseClient): Promise<PrintDesign[]> {
  const productsRes = await supabase
    .from('products')
    .select('*')
    .eq('type', 'print')
    .order('num', { ascending: true });
  if (productsRes.error) throw new Error(`read prints: ${productsRes.error.message}`);

  const ids = (productsRes.data ?? []).map((r) => r.id);
  if (ids.length === 0) return [];

  const [variantsRes, mediaRes] = await Promise.all([
    supabase.from('product_variants').select('*').in('product_id', ids).order('position', { ascending: true }),
    supabase.from('product_media').select('*').in('product_id', ids).order('position', { ascending: true }),
  ]);
  if (variantsRes.error) throw new Error(`read print variants: ${variantsRes.error.message}`);
  if (mediaRes.error) throw new Error(`read print media: ${mediaRes.error.message}`);

  return mapPrintDesigns(
    (productsRes.data ?? []) as ProductSeedRow[],
    (variantsRes.data ?? []) as VariantSeedRow[],
    (mediaRes.data ?? []) as MediaSeedRow[],
  );
}
