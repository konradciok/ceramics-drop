import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Promote a set of `staged` print_fulfilment_assets rows to `ready`, via the
 * `promote_print_assets_ready` RPC (supabase/migrations/20260721120000_promote_print_assets_ready.sql).
 *
 * Used by process-job.ts right after a job successfully stages its
 * derivatives (Priority 8 / Phase 4). Unlike the CLI's print-assets:verify —
 * which re-downloads R2 objects and hashes them against a local manifest,
 * because a CLI upload could come from any machine — this promotion trusts
 * the rows it was JUST asked to promote, because they were staged by the same
 * trusted server-side render this function is called from. There is no
 * separate untrusted-transport step to re-verify here.
 *
 * Never throws for "nothing to promote" (empty r2Keys) — throws only on a
 * genuine RPC error (transient DB fault, or a concurrent revoke racing this
 * call and raising `promotion_state_changed`), which the caller (a queue
 * consumer) should treat as retryable, same as every other DB error in that
 * path.
 */
export async function promoteStagedAssets(
  supabase: SupabaseClient,
  input: { productId: string; revision: string; r2Keys: string[] },
): Promise<{ promoted: { r2Key: string; promoted: boolean }[] }> {
  if (input.r2Keys.length === 0) return { promoted: [] };

  const { data, error } = await supabase.rpc('promote_print_assets_ready', {
    p_product_id: input.productId,
    p_revision: input.revision,
    p_r2_keys: input.r2Keys,
  });
  if (error) throw error;

  const rows = (data ?? []) as { r2_key: string; promoted: boolean }[];
  return { promoted: rows.map((r) => ({ r2Key: r.r2_key, promoted: r.promoted })) };
}
