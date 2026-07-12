/**
 * Admin mutations for print fulfilment assets. Thin wrappers over the server
 * layer so `/api/admin/*` routes and future CLIs share the same logic.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { revokePrintAsset } from '@/server/print-assets/revoke';
import type { ActionResult } from './actions';

function fail(status: number, error: string, extra?: Record<string, unknown>): ActionResult {
  return { status, body: { error, ...extra } };
}

/**
 * Emergency-revoke a fulfilment asset. Blocks checkout and makes the signed route
 * return 410. Pass `force` only when the asset is still assigned to an active
 * variant and the product should become unpurchasable until a new revision ships.
 */
export async function revokePrintAssetAction(
  supabase: SupabaseClient,
  assetId: string,
  opts: { force?: boolean; actorEmail?: string | null },
): Promise<ActionResult> {
  const result = await revokePrintAsset(supabase, assetId, opts);
  if (result.ok) {
    return { status: 200, body: { message: `Asset ${assetId} revoked.` } };
  }
  if (result.reason === 'asset_not_found') return fail(404, 'asset_not_found');
  if (result.reason === 'already_revoked') return fail(409, 'already_revoked');
  if (result.reason === 'invalid_status') return fail(409, 'invalid_status');
  return fail(409, 'still_assigned', { assignedVariants: result.assignedVariants });
}
