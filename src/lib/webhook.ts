import type Stripe from 'stripe';

export type WebhookDeps = {
  /** Flip order pending→paid and pieces reserved→sold. Returns false if already paid (idempotent no-op). */
  markPaid: (paymentIntentId: string) => Promise<boolean>;
  /** Return reserved pieces to available for a failed/canceled intent. */
  releaseHold: (paymentIntentId: string) => Promise<void>;
  /** Generate + send the no-VAT invoice for a freshly-paid order. */
  createInvoice: (paymentIntentId: string) => Promise<void>;
  /** Bust a Next cache tag (e.g. 'inventory'). */
  revalidate: (tag: string) => void;
};

export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const firstTime = await deps.markPaid(pi.id);
      if (firstTime) {
        await deps.createInvoice(pi.id);
        deps.revalidate('inventory');
      }
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
