import type { SupabaseClient } from '@supabase/supabase-js';

export type AbandonedOrder = { id: string; payment_intent_id: string };

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
   * Terminal pending→expired CAS, fenced to the claimant's own lease token
   * (`expiry_claim_at = claimToken`), then free the order's reserved pieces.
   * Returns true if a row was expired; false when nothing matched (already
   * handled, or ownership lost to a newer claimant — must NOT overwrite).
   */
  expireOrder: (orderId: string, claimToken: string) => Promise<boolean>;
  /** Structured log for observability (e.g. a paid PI found on a pending order). */
  warn: (msg: string, meta: Record<string, unknown>) => void;
  /**
   * M-15: alert (email + Sentry) that a paid/processing PI was found on a still-
   * pending order (a likely-missed `payment_intent.succeeded`). Must be
   * de-duplicated (at most once per order) and must NOT throw — a Resend/Sentry
   * outage cannot break the sweep.
   */
  alertPaidOnPending: (orderId: string) => Promise<void>;
};

export type ExpireOrdersResult = { scanned: number; skipped: number; expired: number; stillActive: number; errors: number };

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
      continue;
    }
    const outcome = await deps.cancelIntent(order.payment_intent_id);
    if (outcome === 'canceled') {
      const didExpire = await deps.expireOrder(order.id, claimToken);
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
