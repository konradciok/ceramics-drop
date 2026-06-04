export type AbandonedOrder = { id: string; payment_intent_id: string };

/** Result of trying to cancel an order's PaymentIntent. */
export type CancelOutcome =
  | 'canceled' // PI is canceled (we canceled it, or it was already canceled) → safe to expire
  | 'paid'     // PI succeeded/processing/requires_capture → NOT safe; leave the order alone
  | 'error';   // transient failure → skip this run, retry next time

export type ExpireOrdersDeps = {
  /** pending orders older than the abandonment cutoff, with their PI id (already filtered + limited by the caller). */
  loadAbandoned: () => Promise<AbandonedOrder[]>;
  /** Cancel the PI (see CancelOutcome). Must NOT throw — translate Stripe errors into 'error'/'paid'. */
  cancelIntent: (paymentIntentId: string) => Promise<CancelOutcome>;
  /** Mark the order expired (guarded on status still 'pending') and free its reserved pieces. Returns true if a row was expired. */
  expireOrder: (orderId: string) => Promise<boolean>;
  /** Structured log for observability (e.g. a paid PI found on a pending order). */
  warn: (msg: string, meta: Record<string, unknown>) => void;
};

export type ExpireOrdersResult = { scanned: number; expired: number; stillActive: number; errors: number };

/**
 * Oversell-safe sweep of abandoned checkout orders. For each pending order past
 * the abandonment cutoff, we attempt to cancel its PaymentIntent FIRST. We only
 * expire the order and free its pieces when Stripe confirms the PI is in a
 * cancelable (definitely-not-paid) state — never when it is paid/processing,
 * which would relist a piece the buyer already bought.
 *
 * Orders are processed sequentially (simpler; avoids hammering Stripe).
 */
export async function expireAbandonedOrders(deps: ExpireOrdersDeps): Promise<ExpireOrdersResult> {
  const abandoned = await deps.loadAbandoned();
  const result: ExpireOrdersResult = { scanned: abandoned.length, expired: 0, stillActive: 0, errors: 0 };
  for (const order of abandoned) {
    const outcome = await deps.cancelIntent(order.payment_intent_id);
    if (outcome === 'canceled') {
      const didExpire = await deps.expireOrder(order.id);
      if (didExpire) result.expired += 1;
    } else if (outcome === 'paid') {
      result.stillActive += 1;
      deps.warn('abandoned-sweep: PaymentIntent not cancelable (paid/processing) on a pending order — possible missed webhook', { orderId: order.id, paymentIntentId: order.payment_intent_id });
    } else {
      result.errors += 1;
    }
  }
  return result;
}
