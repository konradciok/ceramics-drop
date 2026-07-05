import { loadStripe, type Stripe } from '@stripe/stripe-js';

let promise: Promise<Stripe | null> | null = null;

/**
 * Singleton Stripe.js loader for the browser.
 *
 * Stripe.js is loaded once and shared (Stripe's recommended pattern — avoids
 * re-creating the Stripe object on every render). The `.catch` guard is the
 * important part: in restricted in-app browsers (Facebook, Instagram WebViews)
 * or on flaky mobile networks the `js.stripe.com` script can fail to load,
 * rejecting this promise. Because the promise lives at module scope and may not
 * have an attached consumer yet (e.g. CartView creates it before `<Elements>`
 * mounts), that rejection would otherwise bubble up as a global
 * `unhandledrejection`. The guard marks the singleton as handled while leaving
 * the original promise free to reject for consumers that await it — they own
 * their own UI fallback.
 */
export function getStripe(): Promise<Stripe | null> {
  if (!promise) {
    promise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
    promise.catch(() => {});
  }
  return promise;
}
