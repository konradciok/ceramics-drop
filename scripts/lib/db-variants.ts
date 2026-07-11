/**
 * DB-backed active print variant lookup for `scripts/print-assets-prepare.ts`.
 *
 * `prepare` must derive "which variants need a derivative" from the SAME
 * source of truth `publish_print_asset_revision` and `getPrintAssetReadiness`
 * check — `product_variants.active` (see
 * `src/server/print-assets/repository.ts`) — not the code registry. A
 * variant an operator deactivates in the DB but that is still declared in
 * `src/lib/prints.ts` must not get a derivative prepared for it, and a draft
 * product must not be prepared at all.
 *
 * Falls back to `PRODIGI_SKU_MAP[variantKey].printAreaPx` only when the DB
 * row's `print_area_*_px` is null (not yet seeded) — the DB value is
 * authoritative when present.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PRODIGI_SKU_MAP } from '../../src/lib/print-cart';
import type { VariantDimension } from '../../src/lib/print-assets-prepare';

/** Row shape of `products.status` (migration `20260709140000_catalog_shadow`). */
type ProductStatus = 'draft' | 'active' | 'hidden' | 'archived';

/**
 * Enumerate a print product's active DB variants with their print-area
 * pixels. Throws on any condition that would silently under- or
 * over-produce derivatives: unknown product, non-active product status, zero
 * active variants, or an active variant with neither seeded DB dimensions
 * nor a `PRODIGI_SKU_MAP` fallback.
 */
export async function activeVariantDimensions(
  supabase: SupabaseClient,
  productId: string,
): Promise<VariantDimension[]> {
  const product = await supabase
    .from('products')
    .select('status')
    .eq('id', productId)
    .maybeSingle();
  if (product.error) {
    throw new Error(`Product lookup failed for "${productId}": ${product.error.message}`);
  }
  if (!product.data) {
    throw new Error(`Unknown print product id: "${productId}" — no row in products.`);
  }
  const status = product.data.status as ProductStatus;
  if (status !== 'active') {
    throw new Error(
      `Product "${productId}" is not active (status="${status}") — refusing to prepare derivatives for a ` +
        'draft/hidden/archived product. Publish it first, or confirm this is intentional before overriding.',
    );
  }

  const variants = await supabase
    .from('product_variants')
    .select('variant_key, print_area_width_px, print_area_height_px')
    .eq('product_id', productId)
    .eq('active', true);
  if (variants.error) {
    throw new Error(`Active variant lookup failed for "${productId}": ${variants.error.message}`);
  }

  const rows = (variants.data ?? []) as Array<{
    variant_key: string;
    print_area_width_px: number | null;
    print_area_height_px: number | null;
  }>;
  if (rows.length === 0) {
    throw new Error(`Product "${productId}" has no active variants in product_variants.`);
  }

  const out: VariantDimension[] = [];
  const unmapped: string[] = [];
  for (const row of rows) {
    let w = row.print_area_width_px;
    let h = row.print_area_height_px;
    if (w == null || h == null) {
      const mapped = PRODIGI_SKU_MAP[row.variant_key];
      if (!mapped) {
        unmapped.push(row.variant_key);
        continue;
      }
      w = mapped.printAreaPx.w;
      h = mapped.printAreaPx.h;
    }
    out.push({ variantKey: row.variant_key, w, h });
  }
  if (unmapped.length > 0) {
    throw new Error(
      `Active variant(s) with no print-area pixels seeded and no PRODIGI_SKU_MAP fallback: ${unmapped.join(', ')}. ` +
        'Seed product_variants.print_area_*_px (npm run catalog:backfill) or add the SKU to src/lib/print-cart.ts.',
    );
  }
  return out;
}
