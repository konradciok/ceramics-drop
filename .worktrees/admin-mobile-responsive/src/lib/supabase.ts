import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Build a service-role Supabase client (bypasses RLS) from an explicit Workers
 * env. Use this in contexts without request ALS (e.g. the scheduled/cron
 * handler), where `getCloudflareContext()` is unavailable.
 */
export function supabaseFromEnv(env: CloudflareEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** Server-only Supabase client using the service-role key (bypasses RLS). */
export function getSupabaseAdmin(): SupabaseClient {
  return supabaseFromEnv(getCloudflareContext().env);
}
