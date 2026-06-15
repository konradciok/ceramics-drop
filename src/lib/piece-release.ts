/**
 * Single decision point for where an order's pieces should land when its hold or
 * sale is released (failed / canceled / expired / refunded / manual admin release).
 *
 * Normal orders relist freed pieces as `available`. Private-sale orders
 * (`orders.private_sale_id` set) sold already-`sold` pieces to one customer via a
 * secret link — those pieces must NEVER reappear in the public shop, so on release
 * they return to (or stay) `sold`. See docs/plans/private-sale-cart-link.md.
 *
 * Kept as a pure function so every release call-site (webhook releaseHold /
 * releaseSale / markPaid, worker cron expireOrder, admin release-reservation)
 * routes the same rule through one Vitest-tested decision.
 */
export type ReleaseTarget = 'sold' | 'available';

export function releaseTargetStatus(order: { private_sale_id?: string | null }): ReleaseTarget {
  return order.private_sale_id ? 'sold' : 'available';
}
