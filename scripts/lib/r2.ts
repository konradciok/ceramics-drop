/**
 * Wrangler R2 helpers for the Phase 2b print-asset operator scripts.
 *
 * Bound `R2Bucket` objects (get/put/head) only exist inside the Workers
 * runtime; these operator scripts run in Node, so they shell out to the
 * Wrangler CLI exactly as scripts/print-asset-inventory.ts does. Wrangler 4.x
 * has no `r2 object head`, so existence + content verification both go through
 * `r2 object get --file` (streamed to disk, never held whole in a JS Buffer).
 *
 * The only write path is `r2Put` (`r2 object put`). `r2GetToFile` and the
 * bucket-name resolution are read-only.
 */
import { spawnSync } from 'node:child_process';
import { loadLocalEnv } from './script-env';

/** Abort a hung Wrangler invocation (e.g. blocked on interactive login) rather than block the operator forever. */
const WRANGLER_TIMEOUT_MS = 120_000;

/**
 * Resolve the print-assets bucket from the same env stack the scripts use for
 * Supabase (`.env.local` < `.dev.vars` < `--env-file` < process.env), NOT just
 * `process.env` — otherwise a `PRINT_ASSETS_BUCKET` staging override placed in
 * `.dev.vars` would be silently ignored and the operator would target prod.
 * Default matches wrangler.jsonc → r2_buckets[0].bucket_name.
 */
export function resolveBucketName(env: Record<string, string | undefined>): string {
  return env.PRINT_ASSETS_BUCKET ?? 'anna-ciok-print-assets';
}

export function printAssetsBucket(): string {
  return resolveBucketName(loadLocalEnv());
}

/**
 * Classify a failed `r2 object get`. A missing object is the normal
 * first-upload case (R2 returns NoSuchKey → "The specified key does not
 * exist."); anything else (auth, throttling, network, broken pipe) is a fault
 * the caller must NOT paper over by assuming the object is absent. Broad
 * not-found matching keeps the happy path working while everything unclassified
 * fails closed.
 */
export function classifyR2GetFailure(stderr: string): 'absent' | 'error' {
  return /does not exist|not found|no such key|nosuchkey|\b404\b|10007/i.test(stderr)
    ? 'absent'
    : 'error';
}

export type R2GetResult =
  | { ok: true }
  | { ok: false; kind: 'absent' | 'error'; error: string };

export interface R2Result {
  ok: boolean;
  error?: string;
}

function describeFailure(res: ReturnType<typeof spawnSync>): string {
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return `wrangler timed out after ${WRANGLER_TIMEOUT_MS}ms (possibly awaiting interactive login)`;
  }
  return (
    (typeof res.stderr === 'string' ? res.stderr.trim() : '') ||
    res.error?.message ||
    `exit ${res.status ?? 'null'}`
  );
}

/**
 * Download `{bucket}/{key}` to `destPath`. On failure, `kind` distinguishes a
 * definitively-absent object (`absent` — safe to proceed to upload) from an
 * unresolved fault (`error` — the caller must fail closed and never assume the
 * key is free to overwrite).
 */
export function r2GetToFile(bucket: string, key: string, destPath: string): R2GetResult {
  const res = spawnSync(
    'npx',
    ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', destPath],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: WRANGLER_TIMEOUT_MS },
  );
  if (res.status === 0) return { ok: true };
  const error = describeFailure(res);
  return { ok: false, kind: classifyR2GetFailure(error), error };
}

/**
 * Upload `filePath` to `{bucket}/{key}` with an explicit `--content-type`
 * (`wrangler r2 object put` does not infer it from the key, so the manifest's
 * contentType is the contract). Content-addressed keys are never overwritten —
 * the caller checks existence first.
 */
export function r2Put(
  bucket: string,
  key: string,
  filePath: string,
  contentType: string,
): R2Result {
  const res = spawnSync(
    'npx',
    [
      'wrangler',
      'r2',
      'object',
      'put',
      `${bucket}/${key}`,
      '--file',
      filePath,
      '--content-type',
      contentType,
      '--remote',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: WRANGLER_TIMEOUT_MS },
  );
  return res.status === 0 ? { ok: true } : { ok: false, error: describeFailure(res) };
}
