import Stripe from 'stripe';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Server-only Stripe client. Created per request so it reads the current
 * Workers env. Uses the fetch HTTP client (Workers has no Node http) and the
 * account-default API version (omit the literal to avoid SDK type drift).
 */
export function getStripe(): Stripe {
  const { env } = getCloudflareContext();
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}
