import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase';
import { supabaseTimeout } from '@/lib/supabase-timeout';
import type { PrintAssetCoverage, PrintAssetReadiness, PrintAssetVariantCoverage, ResolvedPrintAsset } from './types';

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
  revision?: string;
  verified_at?: string | null;
};

type CoverageAssetRow = Pick<
  AssetRow,
  'id' | 'revision' | 'status' | 'width_px' | 'height_px' | 'verified_at'
>;

/** PostgREST may return a many-side embed as an object or a one-element array. */
function coalesceNestedAsset<T extends Pick<AssetRow, 'status' | 'width_px' | 'height_px'>>(
  value: T | T[] | null | undefined,
): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Usable = an assigned asset that is `ready` AND whose width/height equal the
 * variant's print area. A null `print_area_*_px` (unseeded variant) compares
 * unequal → fail-closed. Shared by `resolvePrintAsset` and
 * `getPrintAssetReadiness` so the two stay in lockstep.
 */
function isUsable(
  asset: Pick<AssetRow, 'status' | 'width_px' | 'height_px'> | null,
  printAreaWidth: number | null,
  printAreaHeight: number | null,
): asset is Pick<AssetRow, 'status' | 'width_px' | 'height_px'> {
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
      .eq('active', true)
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

  const asset = coalesceNestedAsset(
    assigned.data?.print_fulfilment_assets as AssetRow | AssetRow[] | null | undefined,
  );
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

/** Fulfilment-time asset record for signing and logging (ready or retired). */
export type FulfilmentAssetRecord = {
  id: string;
  r2Key: string;
  sha256: string;
  revision: string;
  status: string;
};

/**
 * Load an asset row for queue-time URL signing. Returns `null` when the row is
 * absent, revoked, or staged. `ready` and `retired` are both servable —
 * retirement only blocks new checkout assignments, not historical snapshots.
 * `staged` is excluded: those objects may not exist in R2 yet, and the signed
 * route rejects them anyway — signing a staged asset would cause Prodigi to
 * see a 404.
 */
export async function getAssetForFulfilment(
  supabase: SupabaseClient,
  assetId: string,
): Promise<FulfilmentAssetRecord | null> {
  // C-2: the Supabase client is INJECTED (not built via getSupabaseAdmin) because
  // this function is reachable from the queue consumer, which runs outside the
  // request ALS. Callers on the fetch path pass getSupabaseAdmin(); the queue path
  // passes supabaseFromEnv(env). Do not reintroduce getSupabaseAdmin() here.
  const { data, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, r2_key, sha256, revision, status')
    .eq('id', assetId)
    .maybeSingle();

  if (error) {
    throw new Error(`getAssetForFulfilment: lookup failed for ${assetId}: ${error.message}`);
  }
  if (!data || (data.status !== 'ready' && data.status !== 'retired')) return null;
  return {
    id: data.id,
    r2Key: data.r2_key,
    sha256: data.sha256,
    revision: data.revision,
    status: data.status,
  };
}

/**
 * Signed-route resolver: load the immutable R2 key for a snapshotted assetId.
 * Permits `ready` and `retired`; rejects `revoked` and unknown ids.
 */
export type ResolveAssetR2KeyResult =
  | { kind: 'found'; r2Key: string; contentType: 'image/jpeg' | 'image/png'; status: string }
  | { kind: 'revoked' }
  | { kind: 'not_found' };

export async function resolveAssetR2Key(assetId: string): Promise<ResolveAssetR2KeyResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('print_fulfilment_assets')
    .select('r2_key, content_type, status')
    .eq('id', assetId)
    .maybeSingle();

  if (error) {
    throw new Error(`resolveAssetR2Key: lookup failed for ${assetId}: ${error.message}`);
  }
  if (!data) return { kind: 'not_found' };
  if (data.status === 'revoked') return { kind: 'revoked' };
  if (data.status !== 'ready' && data.status !== 'retired') return { kind: 'not_found' };
  return {
    kind: 'found',
    r2Key: data.r2_key,
    contentType: data.content_type as 'image/jpeg' | 'image/png',
    status: data.status,
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
  const coverage = await getPrintAssetCoverage(productId);
  return {
    productId: coverage.productId,
    ready: coverage.ready,
    totalActiveVariants: coverage.totalActiveVariants,
    missing: coverage.missing,
  };
}

/** Admin read model: readiness summary plus per-variant assignment detail. */
export async function getPrintAssetCoverage(
  productId: string,
): Promise<PrintAssetCoverage> {
  const supabase = getSupabaseAdmin();

  const [variants, assignments] = await Promise.all([
    supabase
      .from('product_variants')
      .select('variant_key, print_area_width_px, print_area_height_px')
      .eq('product_id', productId)
      .eq('active', true)
      .order('variant_key')
      .abortSignal(supabaseTimeout()),
    supabase
      .from('print_variant_asset_assignments')
      .select(
        'variant_key, print_fulfilment_assets(id, revision, status, width_px, height_px, verified_at)',
      )
      .eq('product_id', productId)
      .abortSignal(supabaseTimeout()),
  ]);

  if (variants.error)
    throw new Error(
      `getPrintAssetCoverage: variants lookup failed for ${productId}: ${variants.error.message}`,
    );
  if (assignments.error)
    throw new Error(
      `getPrintAssetCoverage: assignments lookup failed for ${productId}: ${assignments.error.message}`,
    );

  const activeVariants = (variants.data ?? []) as Array<{
    variant_key: string;
    print_area_width_px: number | null;
    print_area_height_px: number | null;
  }>;

  const assetByKey = new Map<string, CoverageAssetRow | null>();
  for (const row of assignments.data ?? []) {
    assetByKey.set(
      row.variant_key,
      coalesceNestedAsset(
        row.print_fulfilment_assets as
          | CoverageAssetRow
          | CoverageAssetRow[]
          | null
          | undefined,
      ),
    );
  }

  const variantRows: PrintAssetVariantCoverage[] = activeVariants.map((v) => {
    const asset = assetByKey.get(v.variant_key) ?? null;
    const usable = isUsable(asset, v.print_area_width_px, v.print_area_height_px);
    return {
      variantKey: v.variant_key,
      printAreaWidthPx: v.print_area_width_px,
      printAreaHeightPx: v.print_area_height_px,
      usable,
      asset: asset
        ? {
            id: asset.id,
            revision: asset.revision ?? '',
            widthPx: asset.width_px,
            heightPx: asset.height_px,
            status: asset.status,
            verifiedAt: asset.verified_at ?? null,
          }
        : null,
    };
  });

  const missing = variantRows.filter((v) => !v.usable).map((v) => v.variantKey).sort();

  return {
    productId,
    totalActiveVariants: activeVariants.length,
    ready: missing.length === 0,
    missing,
    variants: variantRows,
  };
}
