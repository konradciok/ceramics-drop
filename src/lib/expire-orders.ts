import type { SupabaseClient } from '@supabase/supabase-js';
import { releaseReservedPieces } from '@/lib/piece-release';

export type AbandonedOrder = {
  id: string;
  payment_intent_id: string;
  /** Routes freed pieces: private-sale orders converge to `sold`, never `available`. */
  private_sale_id?: string | null;
  /** M-5 double-paid refund window marker — a set value denies the expiry claim. */
  refund_pending_at?: string | null;
};

/** Result of trying to cancel an order's PaymentIntent. */
export type CancelOutcome =
  | 'canceled' // PI is canceled (we canceled it, or it was already canceled) → safe to expire
  | 'paid'     // PI succeeded/processing/requires_capture → NOT safe; leave the order alone
  | 'error';   // transient failure → skip this run, retry next time

export type ExpireOrdersDeps = {
  /** pending orders older than the abandonment cutoff, with their PI id (already filtered + limited by the caller). */
  loadAbandoned: () => Promise<AbandonedOrder[]>;
  /**
   * M-5 pending-consumer guard: atomic recoverable lease claim, run BEFORE the
   * irreversible PI cancel. Must be gated on `refund_pending_at IS NULL` and on
   * no other active lease (see {@link claimExpiryLease}). Returns the claim
   * token, or null when the order must be skipped this run (refund-pending,
   * concurrently claimed, or no longer pending).
   */
  claimExpiry: (orderId: string) => Promise<string | null>;
  /** Cancel the PI (see CancelOutcome). Must NOT throw — translate Stripe errors into 'error'/'paid'. */
  cancelIntent: (paymentIntentId: string) => Promise<CancelOutcome>;
  /**
   * Free the order's reserved pieces FIRST, then run the terminal
   * pending→expired CAS fenced to the claimant's own lease token
   * (`expiry_claim_at = claimToken`) — see {@link finalizeExpiry}. Returns true
   * if a row was expired; false when the fenced CAS matched nothing (already
   * handled, or ownership lost to a newer claimant — must NOT overwrite).
   * Throws on a piece-release failure, leaving the order `pending` (never
   * terminal) so the next sweep reclaims the stale lease and retries.
   */
  expireOrder: (order: AbandonedOrder, claimToken: string) => Promise<boolean>;
  /** Structured log for observability (e.g. a paid PI found on a pending order). */
  warn: (msg: string, meta: Record<string, unknown>) => void;
  /**
   * M-15: alert (email + Sentry) that a captured/processing payment sits on a
   * still-pending order needing manual intervention — a likely-missed
   * `payment_intent.succeeded`, or a stale M-5 refund-pending marker whose
   * Stripe retries ran out. Must be de-duplicated (at most once per order) and
   * must NOT throw — a Resend/Sentry outage cannot break the sweep.
   */
  alertPaidOnPending: (orderId: string) => Promise<void>;
};

export type ExpireOrdersResult = { scanned: number; skipped: number; expired: number; stillActive: number; errors: number };

/**
 * An M-5 `refund_pending_at` marker older than this is considered stranded:
 * Stripe retries a failing delivery for ~3 days, but a marker that has sat for
 * a full day with the order still `pending` means the refund leg keeps failing
 * (or the retries are exhausted) — captured, unrefunded money that no consumer
 * may touch. The sweep alerts (at-most-once via the M-15 claim) instead of
 * skipping silently forever.
 */
export const STALE_REFUND_PENDING_MS = 24 * 60 * 60 * 1000;

/**
 * Oversell-safe sweep of abandoned checkout orders. For each pending order past
 * the abandonment cutoff we first take the recoverable expiry lease (skipping
 * refund-pending or concurrently-claimed orders), then attempt to cancel its
 * PaymentIntent. We only expire the order and free its pieces when Stripe
 * confirms the PI is in a cancelable (definitely-not-paid) state — never when
 * it is paid/processing, which would relist a piece the buyer already bought.
 * On any failure after the claim the order stays `pending` and the lease
 * expires, so the next sweep reclaims and retries (recovery preserved).
 *
 * Orders are processed sequentially (simpler; avoids hammering Stripe).
 */
export async function expireAbandonedOrders(deps: ExpireOrdersDeps): Promise<ExpireOrdersResult> {
  const abandoned = await deps.loadAbandoned();
  const result: ExpireOrdersResult = { scanned: abandoned.length, skipped: 0, expired: 0, stillActive: 0, errors: 0 };
  for (const order of abandoned) {
    const claimToken = await deps.claimExpiry(order.id);
    if (claimToken === null) {
      result.skipped += 1;
      // A stale refund-pending marker is captured, unrefunded money the webhook
      // stopped converging (Stripe retries exhausted) — every consumer is
      // locked out by design, so silence here would strand it forever. Reuse
      // the M-15 alert (same semantics, at-most-once via its own claim).
      if (
        order.refund_pending_at &&
        Date.parse(order.refund_pending_at) < Date.now() - STALE_REFUND_PENDING_MS
      ) {
        await deps.alertPaidOnPending(order.id);
      }
      continue;
    }
    const outcome = await deps.cancelIntent(order.payment_intent_id);
    if (outcome === 'canceled') {
      const didExpire = await deps.expireOrder(order, claimToken);
      if (didExpire) result.expired += 1;
    } else if (outcome === 'paid') {
      result.stillActive += 1;
      deps.warn('abandoned-sweep: PaymentIntent not cancelable (paid/processing) on a pending order — possible missed webhook', { orderId: order.id, paymentIntentId: order.payment_intent_id });
      await deps.alertPaidOnPending(order.id);
    } else {
      result.errors += 1;
    }
  }
  return result;
}

// ── Shared expiry-lease CAS (worker cron + admin release-reservation) ─────────

/**
 * Lease TTL for `orders.expiry_claim_at`. Shorter than the 15-min cron period,
 * so a crashed claimant's order is reclaimable by the very next sweep; far
 * longer than the seconds an expiry actually takes.
 */
export const EXPIRY_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Atomic recoverable claim a pending-order consumer MUST take before its
 * irreversible side effect (Stripe PI cancel / piece release). CAS on:
 * `status = 'pending'` AND `refund_pending_at IS NULL` (the M-5 double-paid
 * refund window — such orders are the webhook's to converge, never ours) AND
 * no other active lease (null or stale past {@link EXPIRY_CLAIM_LEASE_MS}).
 * Leaves `status = 'pending'` — on a side-effect failure the order stays
 * retryable and the lease simply expires. Mirrors the
 * `webhook_events.processing_started_at` lease.
 *
 * @returns the claim token (ISO timestamp) to fence the terminal write with,
 * or null when the claim was denied. Throws on a DB error.
 */
export async function claimExpiryLease(
  supabase: SupabaseClient,
  orderId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const claimedAt = new Date(now).toISOString();
  const staleBefore = new Date(now - EXPIRY_CLAIM_LEASE_MS).toISOString();
  const { data, error } = await supabase
    .from('orders')
    .update({ expiry_claim_at: claimedAt })
    .eq('id', orderId)
    .eq('status', 'pending')
    .is('refund_pending_at', null)
    .or(`expiry_claim_at.is.null,expiry_claim_at.lt.${staleBefore}`)
    .select('id');
  if (error) throw new Error(`expiry-claim CAS failed for ${orderId}: ${error.message}`);
  return data && (data as unknown[]).length > 0 ? claimedAt : null;
}

/**
 * Best-effort release of the caller's own lease (CAS on the exact token, so a
 * newer claimant's lease is never clobbered). Used by the admin release path
 * so a failed attempt can be retried immediately instead of waiting out the
 * TTL; never throws — a stuck lease self-heals when it goes stale.
 */
export async function releaseExpiryLease(
  supabase: SupabaseClient,
  orderId: string,
  claimToken: string,
): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ expiry_claim_at: null })
    .eq('id', orderId)
    .eq('expiry_claim_at', claimToken);
  if (error) console.error(`expiry-claim release failed for ${orderId}:`, error.message);
}

/**
 * Finish an expiry AFTER the PI cancel succeeded: free the order's reserved
 * pieces FIRST (private-sale pieces converge to `sold`, never `available`),
 * THEN run the terminal pending→expired CAS fenced to the claimant's own
 * lease token. The ordering is the plan's Task-2 contract: terminal `expired`
 * only after BOTH side effects — a piece-release failure throws and leaves
 * the order `pending` (lease goes stale → the next sweep reclaims and
 * retries), instead of a terminal order with pieces stranded `reserved`
 * (which no sweep would ever revisit, and whose lapsed reservation
 * `reserve_pieces()` would hand to a public checkout).
 *
 * @returns true when the fenced CAS expired the row; false when it matched
 * nothing (already handled, or ownership lost to a newer claimant — the
 * piece release above was idempotent, and the new owner converges the order).
 */
export async function finalizeExpiry(
  supabase: SupabaseClient,
  order: { id: string; private_sale_id?: string | null },
  claimToken: string,
): Promise<boolean> {
  await releaseReservedPieces(supabase, order);
  const { data, error } = await supabase
    .from('orders')
    .update({ status: 'expired', expiry_claim_at: null })
    .eq('id', order.id)
    .eq('status', 'pending')
    .eq('expiry_claim_at', claimToken)
    .select('id');
  if (error) throw new Error(`finalizeExpiry update failed for ${order.id}: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}
