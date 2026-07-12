import type { SupabaseClient } from '@supabase/supabase-js';

export type RevokePrintAssetResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'asset_not_found' | 'already_revoked' | 'invalid_status' | 'still_assigned';
      assignedVariants?: string[];
    };

const REVOCABLE = new Set(['staged', 'ready', 'retired']);

/**
 * Emergency-stop an asset: blocks new checkout assignments and makes the signed
 * route return 410. Distinct from retirement, which preserves historical fulfilment
 * for already-snapshotted orders. Refuses to revoke a live assignment unless
 * `force` is set — the product will become unpurchasable until a new revision is
 * published.
 */
export async function revokePrintAsset(
  supabase: SupabaseClient,
  assetId: string,
  opts?: { force?: boolean; actorEmail?: string | null },
): Promise<RevokePrintAssetResult> {
  const { data: asset, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, product_id, status, revision')
    .eq('id', assetId)
    .maybeSingle();

  if (error) throw new Error(`revokePrintAsset: lookup failed: ${error.message}`);
  if (!asset) return { ok: false, reason: 'asset_not_found' };
  if (asset.status === 'revoked') return { ok: false, reason: 'already_revoked' };
  if (!REVOCABLE.has(asset.status)) return { ok: false, reason: 'invalid_status' };

  // Two reads (no FK between assignments and product_variants on the natural key).
  const { data: assignmentRows, error: assignErr } = await supabase
    .from('print_variant_asset_assignments')
    .select('product_id, variant_key')
    .eq('asset_id', assetId);

  if (assignErr) throw new Error(`revokePrintAsset: assignment lookup failed: ${assignErr.message}`);

  const variantKeys = [...new Set((assignmentRows ?? []).map((row) => row.variant_key as string))];
  let activeAssigned: string[] = [];

  if (variantKeys.length > 0) {
    const { data: variants, error: variantErr } = await supabase
      .from('product_variants')
      .select('variant_key, active')
      .eq('product_id', asset.product_id)
      .in('variant_key', variantKeys);

    if (variantErr) throw new Error(`revokePrintAsset: variant lookup failed: ${variantErr.message}`);

    const activeKeys = new Set(
      (variants ?? []).filter((row) => row.active === true).map((row) => row.variant_key as string),
    );
    activeAssigned = variantKeys.filter((key) => activeKeys.has(key)).sort();
  }

  if (activeAssigned.length > 0 && !opts?.force) {
    return { ok: false, reason: 'still_assigned', assignedVariants: activeAssigned };
  }

  const { data: updated, error: updateErr } = await supabase
    .from('print_fulfilment_assets')
    .update({ status: 'revoked' })
    .eq('id', assetId)
    .eq('status', asset.status)
    .select('id')
    .maybeSingle();
  if (updateErr) throw new Error(`revokePrintAsset: update failed: ${updateErr.message}`);
  if (!updated) return { ok: false, reason: 'already_revoked' };

  const audit = await supabase.from('catalog_audit_log').insert({
    product_id: asset.product_id,
    actor_email: opts?.actorEmail ?? null,
    action: 'print_asset_revoke',
    before: { asset_id: asset.id, status: asset.status, revision: asset.revision },
    after: { asset_id: asset.id, status: 'revoked', force: opts?.force === true },
  });
  if (audit.error) {
    console.error('[print-assets] revoke audit failed', asset.product_id, audit.error.message);
  }

  return { ok: true };
}
