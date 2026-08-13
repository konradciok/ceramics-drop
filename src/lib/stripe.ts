import Stripe from 'stripe';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Build a Stripe client from an explicit Workers env. Use this in contexts
 * without request ALS (e.g. the scheduled/cron handler), where
 * `getCloudflareContext()` is unavailable. Uses the fetch HTTP client (Workers
 * has no Node http).
 *
 * API version: stripe-node ≥ v12 always pins its bundled API version on every
 * request — the account-default version is NOT used
 * (https://docs.stripe.com/sdks/set-version). We pass it explicitly anyway:
 * the `apiVersion` option is typed as the bundled-version literal, so an
 * `npm update stripe` that moves the bundled version fails `npm run typecheck`
 * here instead of silently changing request/webhook payload shapes. When it
 * does, update this literal AND the snapshot webhook endpoint's version in the
 * Stripe Dashboard in lockstep (see AGENTS.md "API-version ritual"), then run
 * `npm run orders -- webhook-config-check`.
 */
export const STRIPE_API_VERSION = '2026-05-27.dahlia' as const;

export function stripeFromEnv(env: CloudflareEnv): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
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
