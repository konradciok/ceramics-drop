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

  const { data: assignments, error: assignErr } = await supabase
    .from('print_variant_asset_assignments')
    .select('variant_key, product_variants!inner(active)')
    .eq('asset_id', assetId);

  if (assignErr) throw new Error(`revokePrintAsset: assignment lookup failed: ${assignErr.message}`);

  const activeAssigned = (assignments ?? [])
    .filter((row) => {
      const pv = row.product_variants as { active: boolean } | { active: boolean }[];
      const active = Array.isArray(pv) ? pv[0]?.active : pv?.active;
      return active === true;
    })
    .map((row) => row.variant_key as string)
    .sort();

  if (activeAssigned.length > 0 && !opts?.force) {
    return { ok: false, reason: 'still_assigned', assignedVariants: activeAssigned };
  }

  const { error: updateErr } = await supabase
    .from('print_fulfilment_assets')
    .update({ status: 'revoked' })
    .eq('id', assetId);
  if (updateErr) throw new Error(`revokePrintAsset: update failed: ${updateErr.message}`);

  const audit = await supabase.from('catalog_audit_log').insert({
    product_id: asset.product_id,
    actor_email: opts?.actorEmail ?? null,
    action: 'print_asset_revoke',
    before: { asset_id: asset.id, status: asset.status, revision: asset.revision },
    after: { asset_id: asset.id, status: 'revoked', force: opts?.force === true },
  });
  if (audit.error) throw new Error(`revokePrintAsset: audit failed: ${audit.error.message}`);

  return { ok: true };
}
