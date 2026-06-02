import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/** Server-only Supabase client using the service-role key (bypasses RLS). */
export function getSupabaseAdmin(): SupabaseClient {
  const { env } = getCloudflareContext();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}
