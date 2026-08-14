import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M-17 / Opp-12: a disaster-recovery operator provisioning from `.env.example`
 * must see every runtime-required variable NAMED — a required key present only
 * in `cloudflare-env.d.ts` (never in `.env.example`) is invisible to them and
 * silently omitted from the redeployed environment. This does NOT assert
 * prod secret *presence* (Plan 04 Task 6 owns that) — only documentation
 * completeness: every required name is visible, and every name actually read
 * by the app is accounted for somewhere (typed, or explicitly allowlisted).
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const dtsSource = readFileSync(join(REPO_ROOT, 'cloudflare-env.d.ts'), 'utf8');
const envExampleSource = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

/** Extract the `interface CloudflareEnv { ... }` body — non-greedy up to its own closing brace at column 0. */
function extractCloudflareEnvBody(source: string): string | null {
  const match = source.match(/interface CloudflareEnv \{([\s\S]*?)\n\}/);
  return match ? match[1] : null;
}

/** Parse `NAME: type;` / `NAME?: type;` property lines (2-space indent) into required/optional key sets. */
function parseDeclaredKeys(interfaceBody: string): { required: Set<string>; optional: Set<string> } {
  const required = new Set<string>();
  const optional = new Set<string>();
  const propertyPattern = /^ {2}([A-Z][A-Z0-9_]*)(\??):/gm;
  let m: RegExpExecArray | null;
  while ((m = propertyPattern.exec(interfaceBody))) {
    (m[2] === '?' ? optional : required).add(m[1]);
  }
  return { required, optional };
}

/** `.env.example` lines: active (uncommented) `KEY=` vs commented-out `# KEY=`. */
function parseEnvExample(source: string): { active: Set<string>; commented: Set<string> } {
  const active = new Set<string>();
  const commented = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const activeMatch = line.match(/^\s*([A-Z][A-Z0-9_]*)=/);
    if (activeMatch) {
      active.add(activeMatch[1]);
      continue;
    }
    const commentedMatch = line.match(/^\s*#\s*([A-Z][A-Z0-9_]*)=/);
    if (commentedMatch) commented.add(commentedMatch[1]);
  }
  return { active, commented };
}

/** Recursively list `.ts`/`.tsx` files under `dir`, excluding `*.test.ts(x)`. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const ENV_READ_PATTERN = /\benv\.([A-Z][A-Z0-9_]*)\b|\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;

/** Every `env.NAME` / `process.env.NAME` name referenced across the given files. */
function collectEnvReads(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = ENV_READ_PATTERN.exec(content))) {
      names.add(m[1] ?? m[2]);
    }
  }
  return names;
}

/**
 * Required keys that are Cloudflare BINDINGS (Queue/R2Bucket/Fetcher/Service),
 * not env vars/secrets — their names live in wrangler.jsonc, not env files, so
 * they legitimately have no `.env.example` line at all (not even commented).
 */
const BINDING_ALLOWLIST = new Set(['ASSETS', 'WORKER_SELF_REFERENCE', 'FULFILMENT_QUEUE', 'PRINT_ASSETS']);

/**
 * Names read via `env.NAME` / `process.env.NAME` in source that are NOT (and
 * should not be) declared in `cloudflare-env.d.ts`'s `CloudflareEnv` — each
 * with why it's a legitimate exception rather than an untyped escape hatch:
 */
const UNTYPED_ALLOWLIST = new Set([
  // Node/Next.js runtime intrinsics — not app config, never part of CloudflareEnv.
  'NODE_ENV',
  'NEXT_RUNTIME',
  'CI',
  // Build-time `NEXT_PUBLIC_*` values inlined into the client bundle by
  // `next build` (see AGENTS.md § Environment Variables) — set as Workers
  // Build env vars, never `wrangler secret put`, never read from the
  // per-request `env` binding object CloudflareEnv types.
  'NEXT_PUBLIC_APP_VERSION',
  'NEXT_PUBLIC_GIT_SHA',
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
  'NEXT_PUBLIC_META_PIXEL_ID',
  'NEXT_PUBLIC_SENTRY_DSN',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN',
  'NEXT_PUBLIC_INPOST_GEOWIDGET_ENV',
  // Build-time-only Workers Build env vars, read via `process.env` at build/
  // module-init time (next.config.ts source-map upload; sentry-options.ts
  // module init) — never part of the per-request `env` binding CloudflareEnv.
  'SENTRY_AUTH_TOKEN',
  'SENTRY_ENVIRONMENT',
  // Deliberately untyped local-override escape hatch (src/lib/admin/clients.ts
  // widens the type instead of extending CloudflareEnv, so a prod deploy can
  // never accidentally pick one up from a typed default) — see L-30 / Plan 09.
  'ADMIN_SUPABASE_URL',
  'ADMIN_SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_STRIPE_SECRET_KEY',
]);

describe('.env.example completeness (M-17 disaster-recovery guard)', () => {
  const interfaceBody = extractCloudflareEnvBody(dtsSource);

  it('parsed the CloudflareEnv interface and found a non-empty required-key set', () => {
    // Fail closed on a parser miss: a silent regex failure must never let the
    // completeness checks below pass vacuously (an empty required-set would
    // make every "every required key has a line" assertion trivially true).
    expect(interfaceBody, 'could not find `interface CloudflareEnv { ... }` in cloudflare-env.d.ts').not.toBeNull();
    const { required } = parseDeclaredKeys(interfaceBody!);
    expect(required.size).toBeGreaterThan(0);
  });

  it('every required CloudflareEnv key (excluding bindings) has an active line in .env.example', () => {
    const { required } = parseDeclaredKeys(interfaceBody!);
    const { active } = parseEnvExample(envExampleSource);

    const missing = [...required].filter((key) => !BINDING_ALLOWLIST.has(key) && !active.has(key));
    expect(
      missing,
      `required key(s) missing an active KEY= line in .env.example (a DR redeploy would silently omit them): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every env/process.env name read in src/**, worker.ts, and next.config.ts is typed or allowlisted', () => {
    const { required, optional } = parseDeclaredKeys(interfaceBody!);
    const declared = new Set([...required, ...optional]);

    const files = [
      ...listSourceFiles(join(REPO_ROOT, 'src')),
      join(REPO_ROOT, 'worker.ts'),
      join(REPO_ROOT, 'next.config.ts'),
    ];
    const readNames = collectEnvReads(files);

    const untyped = [...readNames].filter((name) => !declared.has(name) && !UNTYPED_ALLOWLIST.has(name));
    expect(
      untyped,
      `env name(s) read in source but neither declared in cloudflare-env.d.ts nor on the allowlist: ${untyped.join(', ')}`,
    ).toEqual([]);
  });
});
