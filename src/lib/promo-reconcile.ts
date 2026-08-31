/**
 * Cron reconcile sweep for stale `pending` promo redemptions (Phase 2 Task 2
 * Step 4). Every webhook/cron `'released'` settle is deliberately best-effort
 * (non-throwing after the webhook already 200'd), so a transient Supabase
 * failure would otherwise permanently over-count `max_redemptions` — Sentry
 * alone doesn't recover it. This sweep converges: a redemption still `pending`
 * well past checkout resolution is settled by its order's actual outcome.
 * Every branch is a retry of an already-idempotent RPC, so repeated sweeps
 * converge. Runs as the fifth 15-min cron sweep in worker.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Redemptions `pending` longer than this are stale: checkout holds resolve in
 * 15 min (reserve TTL) and the abandoned-order sweep terminalizes orders after
 * 1 h, so at 2 h the order's status is authoritative.
 */
export const STALE_PENDING_REDEMPTION_MS = 2 * 60 * 60 * 1000;

/** Per-run batch cap, mirroring the other sweeps' bounded scans. */
export const RECONCILE_BATCH_LIMIT = 50;

export type PromoReconcileResult = {
  scanned: number;
  released: number;
  redeemed: number;
  skipped: number;
  errors: number;
  /** Orders found paid with a still-pending redemption — markPaid's miss; caller alerts. */
  paidReconciledOrderIds: string[];
};

export async function sweepStalePromoRedemptions(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<PromoReconcileResult> {
  const cutoff = new Date(now - STALE_PENDING_REDEMPTION_MS).toISOString();
  const { data, error } = await supabase
    .from('promo_redemptions')
    .select('id, order_id, orders(status)')
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .limit(RECONCILE_BATCH_LIMIT);
  if (error) throw new Error(`promo reconcile query failed: ${error.message}`);
  // PostgREST's generated type reads the to-one embed as an array; at runtime
  // an FK embed is a single object (or null) — cast through unknown.
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    order_id: string;
    orders: { status: string } | null;
  }>;

  const result: PromoReconcileResult = {
    scanned: rows.length,
    released: 0,
    redeemed: 0,
    skipped: 0,
    errors: 0,
    paidReconciledOrderIds: [],
  };
  for (const row of rows) {
    const status = row.orders?.status ?? null;
    // Settle by the order's outcome. A still-pending order is left alone (the
    // expiry sweep terminalizes it first — next run converges it); a missing
    // order row (FK'd, so only theoretically possible) is also skipped.
    const target =
      status === 'failed' || status === 'expired' || status === 'refunded'
        ? ('released' as const)
        : status === 'paid'
          ? ('redeemed' as const)
          : null;
    if (!target) {
      result.skipped += 1;
      continue;
    }
    try {
      const { error: settleErr } = await supabase.rpc('settle_promo_redemption', {
        p_order_id: row.order_id,
        p_status: target,
      });
      if (settleErr) throw new Error(settleErr.message);
      if (target === 'redeemed') {
        result.redeemed += 1;
        result.paidReconciledOrderIds.push(row.order_id);
      } else {
        result.released += 1;
      }
    } catch (err) {
      // Per-row failures never stop the sweep; the next run retries.
      result.errors += 1;
      console.error('promo reconcile settle failed for', row.order_id, err);
    }
  }
  return result;
}
