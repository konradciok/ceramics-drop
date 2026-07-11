/**
 * LOCAL-ONLY admin clients. Never committed/deployed (gitignored via
 * .git/info/exclude). Mirror `getSupabaseAdmin()` / `getStripe()` but read
 * dedicated `ADMIN_*` env overrides first, falling back to the storefront
 * vars. This lets the local admin point at PRODUCTION while `npm run dev`'s
 * storefront keeps using whatever the shared env (.dev.vars) provides.
 *
 * Set in .dev.vars when the shared env is NOT production:
 *   ADMIN_SUPABASE_URL, ADMIN_SUPABASE_SERVICE_ROLE_KEY, ADMIN_STRIPE_SECRET_KEY
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/** Env widened so the optional ADMIN_* keys (absent from cloudflare-env.d.ts) read cleanly. */
type AdminEnv = CloudflareEnv & Record<string, string | undefined>;

function adminEnv(): AdminEnv {
  return getCloudflareContext().env as AdminEnv;
}

/**
 * Pure client factories — no `getCloudflareContext()` dependency, so callers
 * outside an OpenNext/Workers request (e.g. `scripts/orders-cli.ts`) can build
 * the same clients from their own loaded env. Mirrors `supabaseFromEnv()`.
 */
export function adminSupabaseFromEnv(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false } });
}

export function adminStripeFromEnv(key: string): Stripe {
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

export function adminSupabase(): SupabaseClient {
  const env = adminEnv();
  const url = env.ADMIN_SUPABASE_URL ?? env.SUPABASE_URL;
  const key = env.ADMIN_SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  return adminSupabaseFromEnv(url, key);
}

export function adminStripe(): Stripe {
  const env = adminEnv();
  const key = env.ADMIN_STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
  return adminStripeFromEnv(key);
}
