/**
 * Shared env loading + Supabase client for the Phase 2b print-asset operator
 * scripts (upload / verify / publish). Same precedence as orders-cli.ts /
 * prodigi-cli.ts — `.env.local` < `.dev.vars` < `--env-file <path>` <
 * process.env — so a git-worktree checkout or an explicit `.dev.vars` path can
 * be pointed at with `--env-file`. Factored out so the three new scripts don't
 * each re-implement it.
 */
import fs from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseEnvFileOption } from './print-assets-cli';

const NEWLINE = /\r?\n/;

/** Parse a `KEY=value` dotenv file (quotes stripped). Missing file → {}. */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(NEWLINE)) {
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

/** `.env.local` < `.dev.vars` < `--env-file` < process.env (later wins). */
export function loadLocalEnv(): Record<string, string | undefined> {
  const envFile = parseEnvFileOption();
  return {
    ...parseEnvFile('.env.local'),
    ...parseEnvFile('.dev.vars'),
    ...(envFile ? parseEnvFile(envFile) : {}),
    ...process.env,
  };
}

export function loadSupabaseClient(): SupabaseClient {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, --env-file, or process env.');
  }
  // Non-interactive service-role client: disable every browser/session
  // mechanism, not just persistence.
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
