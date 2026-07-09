/* ============================================================
   Catalog repository — DB read/write for the product catalogue
   ------------------------------------------------------------
   Stage 0: only the idempotent backfill is exercised (shadow tables). The read
   helpers exist for the Stage 3 storefront flip and are intentionally not wired
   into any public path yet.
   ============================================================ */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Product } from '../types';
import { buildCatalogSeed } from './seed';
import { mapCeramicProducts } from './mappers';
import type { MediaSeedRow, ProductSeedRow } from './types';

/**
 * Idempotently mirror the code registry into the catalog tables. Safe to re-run:
 * products upsert on `id`, variants on `(product_id, variant_key)`, media on
 * `(product_id, url)`. This does NOT touch piece_state / orders — stock and sale
 * state stay where they are until a later stage.
 */
export async function backfillCatalog(supabase: SupabaseClient): Promise<void> {
  const seed = buildCatalogSeed();

  const products = await supabase
    .from('products')
    .upsert(seed.products, { onConflict: 'id' });
  if (products.error) throw new Error(`backfill products: ${products.error.message}`);

  const variants = await supabase
    .from('product_variants')
    .upsert(seed.variants, { onConflict: 'product_id,variant_key' });
  if (variants.error) throw new Error(`backfill variants: ${variants.error.message}`);

  const media = await supabase
    .from('product_media')
    .upsert(seed.media, { onConflict: 'product_id,url' });
  if (media.error) throw new Error(`backfill media: ${media.error.message}`);
}

/**
 * Read the ceramic catalogue from the DB and reconstruct `Product[]` in
 * category → display-num order. Reserved for the Stage 3 flip; not yet called by
 * any storefront surface.
 */
export async function readCeramicProducts(supabase: SupabaseClient): Promise<Product[]> {
  const productsRes = await supabase
    .from('products')
    .select('*')
    .eq('type', 'ceramic')
    .order('category_slug', { ascending: true })
    .order('num', { ascending: true });
  if (productsRes.error) throw new Error(`read products: ${productsRes.error.message}`);

  const ids = (productsRes.data ?? []).map((r) => r.id);
  const mediaRes = await supabase.from('product_media').select('*').in('product_id', ids);
  if (mediaRes.error) throw new Error(`read media: ${mediaRes.error.message}`);

  return mapCeramicProducts(
    (productsRes.data ?? []) as ProductSeedRow[],
    (mediaRes.data ?? []) as MediaSeedRow[],
  );
}
