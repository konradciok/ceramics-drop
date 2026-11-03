import { distinctProfiles, type VariantDimension } from '@/lib/print-assets-prepare';

export interface PublishAssignment {
  variant_key: string;
  asset_id: string;
}

export type PublishAssignmentResult =
  | { kind: 'ok'; assignments: PublishAssignment[] }
  | { kind: 'missing_profiles'; missingVariantKeys: string[] };

/**
 * Build the (variant_key, asset_id) pairs `publish_print_asset_revision`
 * needs, for every ACTIVE variant of a product — not just the ratio one
 * upload covered. `readyAssetIdByProfileKey` is keyed by
 * print_fulfilment_assets.profile_key ("60x80") — a real, directly queryable
 * column (see supabase/migrations/20260711120000_print_fulfilment_assets.sql),
 * not reconstructed from the content-addressed r2_key (which would need the
 * derivative's sha256, something this caller never independently computes).
 *
 * Fails closed (kind: 'missing_profiles') rather than throwing when a
 * variant's profile has no ready row yet — this is the expected, documented
 * shape of the multi-ratio-product limitation (profiles.ts's own header
 * comment): a single CMS upload only ever stages ONE ratio's profiles, so a
 * product spanning multiple ratios will always be missing some variants here
 * until every ratio has its own upload under the same revision. The caller
 * turns this into a clear operator-facing error instead of an opaque RPC
 * failure.
 */
export function buildJobPublishAssignments(
  variants: VariantDimension[],
  readyAssetIdByProfileKey: Map<string, string>,
): PublishAssignmentResult {
  const profiles = distinctProfiles(variants);
  const assignments: PublishAssignment[] = [];
  const missingVariantKeys: string[] = [];

  for (const profile of profiles) {
    const assetId = readyAssetIdByProfileKey.get(profile.profileKey);
    if (!assetId) {
      missingVariantKeys.push(...profile.variantKeys);
      continue;
    }
    for (const variantKey of profile.variantKeys) {
      assignments.push({ variant_key: variantKey, asset_id: assetId });
    }
  }

  if (missingVariantKeys.length > 0) {
    return { kind: 'missing_profiles', missingVariantKeys: missingVariantKeys.sort() };
  }
  return { kind: 'ok', assignments };
}
