/**
 * Single decision point for where an order's pieces should land when its hold or
 * sale is released (failed / canceled / expired / refunded / manual admin release).
 *
 * Normal orders relist freed pieces as `available`. Private-sale orders
 * (`orders.private_sale_id` set) sold already-`sold` pieces to one customer via a
 * secret link — those pieces must NEVER reappear in the public shop, so on release
 * they return to (or stay) `sold`. See docs/plans/private-sale-cart-link.md.
 *
 * `releaseTargetStatus` is the pure decision and is used at every release
 * call-site (webhook releaseHold / releaseSale / markPaid, worker cron
 * expireOrder, checkout error paths). `releaseReservedPieces` wraps the
 * reserved-hold *write* for callers that already own the order (the Stripe
 * webhook `releaseHold`, the cron expiry, the admin release). The checkout
 * route's error paths use `releaseOrphanedCheckoutHold` instead: a concurrent
 * POST with the same attemptId may own the same hold, so that release frees
 * nothing while a live order exists.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type ReleaseTarget = 'sold' | 'available';

export function releaseTargetStatus(order: { private_sale_id?: string | null }): ReleaseTarget {
  return order.private_sale_id ? 'sold' : 'available';
}

/**
 * Free an order's still-`reserved` pieces, routing where they land through
 * {@link releaseTargetStatus} (normal → `available`, private-sale → `sold`).
 * Only rows still `status = 'reserved'` for this order are touched, so it is
 * idempotent — a second call after the hold is already gone returns `[]`.
 *
 * Used by the Stripe webhook `releaseHold` (failed / canceled), the cron
 * expiry and the admin manual release, so the rule and the query live in one
 * tested place. It releases unconditionally: never call it from checkout,
 * where another request may still own the hold (see
 * {@link releaseOrphanedCheckoutHold}). Throws on a piece_state failure so
 * callers can surface it: `releaseHold` is retry-safe (re-fetches the already-`failed` order on a
 * Stripe re-delivery), so the resulting webhook 5xx makes Stripe retry the
 * release until it sticks instead of leaving pieces stuck as `reserved`.
 *
 * @returns the freed `product_id`s.
 */
export async function releaseReservedPieces(
  supabase: SupabaseClient,
  order: { id: string; private_sale_id?: string | null },
): Promise<string[]> {
  const { data, error } = await supabase
    .from('piece_state')
    .update({ status: releaseTargetStatus(order), reserved_until: null, order_id: null })
    .eq('order_id', order.id)
    .eq('status', 'reserved')
    .select('product_id');
  if (error) throw new Error(`releaseReservedPieces failed for order ${order.id}: ${error.message}`);
  return ((data as Array<{ product_id: string }> | null) ?? []).map((r) => r.product_id);
}

export type CheckoutHoldRelease = 'released' | 'live_order';

/**
 * Checkout's own release: free the hold of an attempt only when no live order
 * owns it. The `release_orphaned_checkout_hold` RPC locks the order's reserved
 * rows, then frees them only if no `pending` or `paid` order exists for this
 * id; checkout re-runs its reservation after the orders insert, so the two
 * serialise on the piece rows and a hold an in-flight request still owns is
 * never freed (migration 20261125120000 has the full argument).
 *
 * @returns `'released'` (rows freed, or nothing was reserved) or
 * `'live_order'` (a live order owns the hold; nothing was freed). Throws on an
 * RPC failure, when nothing is known to have been freed.
 */
export async function releaseOrphanedCheckoutHold(
  supabase: SupabaseClient,
  order: { id: string; private_sale_id?: string | null },
): Promise<CheckoutHoldRelease> {
  const { data, error } = await supabase.rpc('release_orphaned_checkout_hold', {
    p_order_id: order.id,
    p_target_status: releaseTargetStatus(order),
  });
  if (error) throw new Error(`releaseOrphanedCheckoutHold failed for order ${order.id}: ${error.message}`);
  if (data !== 'released' && data !== 'live_order') {
    throw new Error(`releaseOrphanedCheckoutHold: unexpected result for order ${order.id}: ${String(data)}`);
  }
  return data as CheckoutHoldRelease;
}
