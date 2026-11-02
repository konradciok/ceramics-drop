import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createStallRetryFetch } from './supabase-stall-retry';

/**
 * Build a service-role Supabase client (bypasses RLS) from an explicit Workers
 * env. Use this in contexts without request ALS (e.g. the scheduled/cron
 * handler), where `getCloudflareContext()` is unavailable.
 */
export function supabaseFromEnv(env: CloudflareEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    // Retries a bounded read once when its connection stalls before any
    // response headers — see supabase-stall-retry.ts for the scope.
    global: { fetch: createStallRetryFetch() },
  });
}

/** Server-only Supabase client using the service-role key (bypasses RLS). */
export function getSupabaseAdmin(): SupabaseClient {
  return supabaseFromEnv(getCloudflareContext().env);
}
