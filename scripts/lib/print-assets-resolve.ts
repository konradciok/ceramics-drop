/**
 * Shared fulfilment-asset resolution for print-asset operator scripts.
 */
import { PRODIGI_SKU_MAP, parseVariantKey } from '../../src/lib/print-cart';
import { buildProdigiAttributes } from '../../src/lib/print-prodigi-attributes';
import { profileKeyFromPx } from '../../src/lib/print-assets-prepare';
import { loadSupabaseClient } from './script-env';

// Re-export the canonical profile-key helper so callers already importing it
// from this module keep working (one source of truth in print-assets-prepare).
export { profileKeyFromPx };

export interface ReadyAssetRow {
  id: string;
  profile_key: string;
  revision: string;
  verified_at: string | null;
}

export interface ReadyAssetDetail extends ReadyAssetRow {
  r2_key: string;
  sha256: string;
}

export interface SandboxMatrixRow {
  profileKey: string;
  variantKey: string;
  sku: string;
  attributes: Record<string, string>;
}

export function galleryR2Key(productId: string, slot: string, filename: string): string {
  return `prints/${productId}/gallery/${slot}/${filename}`;
}

/**
 * Given rows sorted by `verified_at` descending, keep the first (latest verified)
 * row per `profile_key`.
 */
export function latestReadyByProfile(rows: ReadyAssetRow[]): Map<string, ReadyAssetRow> {
  const byProfile = new Map<string, ReadyAssetRow>();
  for (const row of rows) {
    if (!byProfile.has(row.profile_key)) byProfile.set(row.profile_key, row);
  }
  return byProfile;
}

/** One sandbox order per distinct print-area profile, derived from PRODIGI_SKU_MAP. */
export function buildSandboxMatrix(): SandboxMatrixRow[] {
  const entries = Object.entries(PRODIGI_SKU_MAP).sort(([a], [b]) => a.localeCompare(b));
  const byProfile = new Map<string, { variantKey: string; sku: string }>();

  for (const [variantKey, { sku, printAreaPx }] of entries) {
    const profileKey = profileKeyFromPx(printAreaPx.w, printAreaPx.h);
    if (byProfile.has(profileKey)) continue;
    byProfile.set(profileKey, { variantKey, sku });
  }

  return [...byProfile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profileKey, { variantKey, sku }]) => ({
      profileKey,
      variantKey,
      sku,
      attributes: buildProdigiAttributes(parseVariantKey(variantKey)),
    }));
}

export async function resolveLatestReadyByProfile(productId: string): Promise<Map<string, ReadyAssetRow>> {
  const supabase = loadSupabaseClient();
  const { data, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, profile_key, revision, verified_at, sha256')
    .eq('product_id', productId)
    .eq('status', 'ready')
    .order('verified_at', { ascending: false })
    .order('sha256', { ascending: false });
  if (error) throw new Error(`asset lookup failed: ${error.message}`);
  return latestReadyByProfile((data ?? []) as ReadyAssetRow[]);
}

/** Latest ready asset for one profile (optional revision pin). */
export async function resolveLatestReadyAsset(
  productId: string,
  sourceProfile: string,
  revisionArg: string | undefined,
): Promise<ReadyAssetDetail> {
  const supabase = loadSupabaseClient();
  let query = supabase
    .from('print_fulfilment_assets')
    .select('id, revision, profile_key, r2_key, sha256, verified_at')
    .eq('product_id', productId)
    .eq('profile_key', sourceProfile)
    .eq('status', 'ready');

  if (revisionArg) query = query.eq('revision', revisionArg);

  const { data, error } = await query
    .order('verified_at', { ascending: false })
    .order('sha256', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Failed to read fulfilment assets: ${error.message}`);
  if (!data?.length) {
    throw new Error(
      `No ready print_fulfilment_assets row for ${productId} profile ${sourceProfile}` +
        (revisionArg ? ` revision ${revisionArg}` : '') +
        '. Run prepare/upload/verify/publish first.',
    );
  }
  const row = data[0]!;
  return {
    id: row.id as string,
    revision: row.revision as string,
    profile_key: row.profile_key as string,
    r2_key: row.r2_key as string,
    sha256: row.sha256 as string,
    verified_at: row.verified_at as string | null,
  };
}
