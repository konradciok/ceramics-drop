import { getSupabaseAdmin } from '@/lib/supabase';
import type { PrintAssetReadiness, ResolvedPrintAsset } from './types';

/**
 * Server-side repository (read-only) for the print-asset fulfilment tables.
 * Queries mirror the `cancel-print.ts` / `process-job` pattern: service-role
 * client + `.from().select().eq()` chains. No inserts/updates here — publishing
 * is the `publish_print_asset_revision` RPC's job (Phase 2).
 */

const READY = 'ready' as const;

/** A nested `print_fulfilment_assets` row as PostgREST returns it (snake_case). */
type AssetRow = {
  id: string;
  r2_key: string;
  sha256: string;
  content_type: 'image/jpeg' | 'image/png';
  width_px: number;
  height_px: number;
  status: string;
};

/**
 * Usable = an assigned asset that is `ready` AND whose width/height equal the
 * variant's print area. A null `print_area_*_px` (unseeded variant) compares
 * unequal → fail-closed. Shared by `resolvePrintAsset` and
 * `getPrintAssetReadiness` so the two stay in lockstep.
 */
function isUsable(
  asset: AssetRow | null,
  printAreaWidth: number | null,
  printAreaHeight: number | null,
): asset is AssetRow {
  return (
    asset !== null &&
    asset.status === READY &&
    printAreaWidth !== null &&
    printAreaHeight !== null &&
    asset.width_px === printAreaWidth &&
    asset.height_px === printAreaHeight
  );
}

/**
 * Checkout-time resolver: the asset usable for a NEW order on this variant, or
 * `null` when none is usable. Usable = assigned + status `ready` (NOT `retired`
 * — that is served only via the signed route for already-snapshotted historical
 * orders in Phase 4) + dimensions match the variant's print area (defense in
 * depth for plan §4's "dimensionally inconsistent → unavailable"; the publish
 * RPC enforces this at assignment, but a later re-seed could drift).
 *
 * Two parallel reads (no FK between assignments and product_variants on the
 * natural key, so the dim check is reconciled in TS rather than joined).
 */
export async function resolvePrintAsset(
  productId: string,
  variantKey: string,
): Promise<ResolvedPrintAsset | null> {
  const supabase = getSupabaseAdmin();

  const [assigned, variant] = await Promise.all([
    supabase
      .from('print_variant_asset_assignments')
      .select(
        'asset_id, print_fulfilment_assets(id, r2_key, sha256, content_type, width_px, height_px, status)',
      )
      .eq('product_id', productId)
      .eq('variant_key', variantKey)
      .maybeSingle(),
    supabase
      .from('product_variants')
      .select('print_area_width_px, print_area_height_px')
      .eq('product_id', productId)
      .eq('variant_key', variantKey)
      .maybeSingle(),
  ]);

  if (assigned.error)
    throw new Error(
      `resolvePrintAsset: assignment lookup failed for ${productId}/${variantKey}: ${assigned.error.message}`,
    );
  if (variant.error)
    throw new Error(
      `resolvePrintAsset: variant lookup failed for ${productId}/${variantKey}: ${variant.error.message}`,
    );

  const asset = (assigned.data?.print_fulfilment_assets ?? null) as AssetRow | null;
  const paw = variant.data?.print_area_width_px ?? null;
  const pah = variant.data?.print_area_height_px ?? null;
  if (!isUsable(asset, paw, pah)) return null;

  return {
    assetId: asset.id,
    r2Key: asset.r2_key,
    sha256: asset.sha256,
    contentType: asset.content_type,
    widthPx: asset.width_px,
    heightPx: asset.height_px,
  };
}

/**
 * Publish-guard (Phase 5) + admin view of a product's asset coverage. `ready` is
 * true iff every active variant has a usable assignment (ready + dim-matched).
 * Zero active variants is vacuously ready. Computed in two queries (active
 * variants + their print-area dims, assignments joined to their asset) then
 * reconciled in TS — no N+1.
 */
export async function getPrintAssetReadiness(
  productId: string,
): Promise<PrintAssetReadiness> {
  const supabase = getSupabaseAdmin();

  const [variants, assignments] = await Promise.all([
    supabase
      .from('product_variants')
      .select('variant_key, print_area_width_px, print_area_height_px')
      .eq('product_id', productId)
      .eq('active', true),
    supabase
      .from('print_variant_asset_assignments')
      .select('variant_key, print_fulfilment_assets(status, width_px, height_px)')
      .eq('product_id', productId),
  ]);

  if (variants.error)
    throw new Error(
      `getPrintAssetReadiness: variants lookup failed for ${productId}: ${variants.error.message}`,
    );
  if (assignments.error)
    throw new Error(
      `getPrintAssetReadiness: assignments lookup failed for ${productId}: ${assignments.error.message}`,
    );

  const activeVariants = (variants.data ?? []) as Array<{
    variant_key: string;
    print_area_width_px: number | null;
    print_area_height_px: number | null;
  }>;

  // Index assignments by variant_key for O(1) lookup.
  const assetByKey = new Map<string, AssetRow | null>();
  for (const row of (assignments.data ?? []) as Array<{
    variant_key: string;
    print_fulfilment_assets: AssetRow | null;
  }>) {
    assetByKey.set(row.variant_key, row.print_fulfilment_assets);
  }

  const missing: string[] = [];
  for (const v of activeVariants) {
    if (!isUsable(assetByKey.get(v.variant_key) ?? null, v.print_area_width_px, v.print_area_height_px)) {
      missing.push(v.variant_key);
    }
  }

  return {
    productId,
    totalActiveVariants: activeVariants.length,
    ready: missing.length === 0,
    // ponytail: default Array.prototype.sort() is lexicographic + stable for
    // strings — exactly the "sorted, stable" contract. Add a comparator only
    // if variant keys ever need locale-aware ordering.
    missing: missing.sort(),
  };
}
