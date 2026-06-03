import type Stripe from 'stripe';

export type WebhookDeps = {
  /** Flip order pending→paid and claim pieces still reserved to this order. Returns false if already processed (idempotent no-op). */
  markPaid: (paymentIntentId: string) => Promise<boolean>;
  /** Return reserved pieces to available for a failed/canceled intent. */
  releaseHold: (paymentIntentId: string) => Promise<void>;
  /** Attempt to invoice if not already invoiced; idempotent — safe to call on every succeeded event. */
  ensureInvoiced: (paymentIntentId: string) => Promise<void>;
  /** Bust a Next cache tag (e.g. 'inventory'). */
  revalidate: (tag: string) => void;
};

export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const newlySold = await deps.markPaid(pi.id);
      if (newlySold) deps.revalidate('inventory');
      await deps.ensureInvoiced(pi.id);
      return;
    }
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      await deps.releaseHold(pi.id);
      deps.revalidate('inventory');
      return;
    }
    default:
      return;
  }
}
