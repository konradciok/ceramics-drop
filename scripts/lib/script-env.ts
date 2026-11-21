/**
 * Shared env loading + Supabase client for operator scripts. Same precedence
 * as orders-cli.ts — `.env.local` < `.dev.vars` < `--env-file <path>` <
 * process.env — so a git-worktree checkout or an explicit `.dev.vars` path can
 * be pointed at with `--env-file`.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * `--env-file <path>` / `--env-file=<path>`, tolerant of any other flags in
 * `argv` (non-strict, positionals allowed) so it can be read regardless of a
 * given script's own flag spec. Supplied more than once, or with an empty
 * value, is rejected rather than silently taking the last one.
 */
export function parseEnvFileOption(argv: string[] = process.argv.slice(2)): string | undefined {
  const { values } = parseArgs({
    args: argv,
    options: { 'env-file': { type: 'string', multiple: true } },
    strict: false,
    allowPositionals: true,
  });
  // `strict: false` widens the inferred value type to `string | boolean` for
  // every option — and that widening is real at runtime: a declared
  // `type: 'string'` option parses as boolean `true` when its value is missing
  // (bare `--env-file` as the last token), so normalise before validating.
  const raw = values['env-file'] as string | boolean | Array<string | boolean> | undefined;
  const valuesList = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  if (valuesList.length > 1) throw new Error('--env-file may be supplied only once');
  const value = valuesList[0];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('--env-file requires a value');
  if (value.trim() === '') throw new Error('--env-file must be non-empty');
  return value;
}

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
