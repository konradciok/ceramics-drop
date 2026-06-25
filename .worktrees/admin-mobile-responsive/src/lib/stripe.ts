import Stripe from 'stripe';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Build a Stripe client from an explicit Workers env. Use this in contexts
 * without request ALS (e.g. the scheduled/cron handler), where
 * `getCloudflareContext()` is unavailable. Uses the fetch HTTP client (Workers
 * has no Node http) and the account-default API version.
 */
export function stripeFromEnv(env: CloudflareEnv): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/**
 * Server-only Stripe client for the current request. Reads the live Workers env
 * via request ALS.
 */
export function getStripe(): Stripe {
  return stripeFromEnv(getCloudflareContext().env);
}
