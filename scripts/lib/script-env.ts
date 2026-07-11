/**
 * Shared env loading + Supabase client for the Phase 2b print-asset operator
 * scripts (upload / verify / publish). Same `.env.local` → `.dev.vars` →
 * process.env precedence as backfill-catalog.ts / sync-prodigi-skus.ts /
 * print-assets-prepare.ts; factored out so the three new scripts don't each
 * re-implement it.
 */
import fs from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Parse a `KEY=value` dotenv file (quotes stripped). Missing file → {}. */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** `.env.local` < `.dev.vars` < process.env (later wins). */
export function loadLocalEnv(): Record<string, string | undefined> {
  return { ...parseEnvFile('.env.local'), ...parseEnvFile('.dev.vars'), ...process.env };
}

export function loadSupabaseClient(): SupabaseClient {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
