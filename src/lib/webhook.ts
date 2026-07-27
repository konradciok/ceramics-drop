import type Stripe from 'stripe';

export type WebhookDeps = {
  /** Flip order pending→paid and claim pieces still reserved to this order. Returns false if already processed (idempotent no-op). */
  markPaid: (paymentIntentId: string) => Promise<boolean>;
  /** Return reserved pieces to available for a canceled PaymentIntent. */
  releaseHold: (paymentIntentId: string) => Promise<void>;
  /**
   * Converge a fully-refunded / lost-dispute payment to `refunded` and return
   * its ceramic pieces to the shop (private-sale orders converge their
   * pieces to `sold` instead — never relisted publicly), regardless of
   * event delivery order: a paid order is relisted; a still-pending
   * order (refund observed before
   * `payment_intent.succeeded`) is parked `refunded` so the late success can
   * never fulfil it; an already-`refunded` order re-checks that the release
   * actually stuck and finishes it (crash-resume). Returns true if pieces were
   * (re)listed, false if nothing to do. The implementation MUST no-op for
   * `failed` orders: the markPaid under-fulfillment path issues its own refund
   * (and already sets the order `failed` + frees pieces), so the resulting
   * charge.refunded event must find nothing to do here.
   */
  releaseSale: (paymentIntentId: string) => Promise<boolean>;
  /** Attempt to invoice if not already invoiced; idempotent — safe to call on every succeeded event. */
  ensureInvoiced: (paymentIntentId: string) => Promise<void>;
  /** Create the InPost shipment for a freshly-paid order (no-op for studio pickup). */
  createShipment: (paymentIntentId: string) => Promise<void>;
  /** Bust a Next cache tag (e.g. 'inventory'). */
  revalidate: (tag: string) => void;
  /** Fire server-side purchase conversions (Meta CAPI + GA4 MP). Best-effort: errors swallowed by the impl. */
  trackPurchase: (paymentIntentId: string) => Promise<void>;
};

/** Extract a payment-intent id from a field that Stripe may expand or leave as a string. */
function extractPiId(raw: string | { id: string } | null | undefined): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  return raw.id;
}

export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<void> {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const newlySold = await deps.markPaid(pi.id);
      if (newlySold) deps.revalidate('inventory');
      await deps.trackPurchase(pi.id);
      await deps.ensureInvoiced(pi.id);
      // Shipment creation is idempotent (guarded by inpost_shipment_id) and is
      // allowed to throw so a failed attempt re-runs on Stripe's webhook retry.
      await deps.createShipment(pi.id);
      return;
    }
    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await deps.releaseHold(pi.id);
      deps.revalidate('inventory');
      return;
    }
    case 'payment_intent.payment_failed':
      // Per-attempt, not terminal: Stripe fires this on every declined
      // confirmation while the PaymentIntent stays open for retry with a
      // different payment method (typical: a second card, same PI id).
      // Releasing the hold here let a same-PI retry that later succeeds land
      // on an already-`failed` order and silently do nothing (markPaid's
      // `existing.status !== 'paid'` branch) — money taken, no order. The
      // 15-minute reservation TTL (and the cron sweep after 1h) already
      // reclaims an abandoned hold, so no action is needed on this event.
      return;
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      // Only act on a full refund — partial refunds (e.g. shipping only) must NOT relist.
      if (charge.amount_refunded < charge.amount) return;
      const piId = extractPiId(charge.payment_intent);
      if (!piId) return;
      const relisted = await deps.releaseSale(piId);
      if (relisted) deps.revalidate('inventory');
      return;
    }
    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute;
      // Only relist when the dispute is definitively lost — a won dispute must NOT relist.
      if (dispute.status !== 'lost') return;
      const piId = extractPiId(dispute.payment_intent);
      if (!piId) return;
      const relisted = await deps.releaseSale(piId);
      if (relisted) deps.revalidate('inventory');
      return;
    }
    default:
      return;
  }
}
