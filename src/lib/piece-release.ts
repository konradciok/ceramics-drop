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
 * reserved-hold *write*: the Stripe webhook `releaseHold` and the checkout
 * route's error paths (Stripe failure, order_conflict replay, order-persist
 * rollback) use it; the local admin manual-release route will adopt it when
 * that panel lands. The worker cron `expireOrder` still inlines the write.
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
 * Used by the Stripe webhook `releaseHold` (failed / canceled) and the checkout
 * route's error paths (which wrap it in a logging `.catch` — a failed release
 * must not eat the checkout response); the local admin manual-release route
 * will adopt it when that panel lands, so the rule and the query live in one
 * tested place. Throws on a piece_state failure so callers can surface it:
 * `releaseHold` is retry-safe (re-fetches the already-`failed` order on a
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
