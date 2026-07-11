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

/** Matches wrangler.jsonc → r2_buckets[0].bucket_name. Override for non-prod buckets. */
export function printAssetsBucket(): string {
  return process.env.PRINT_ASSETS_BUCKET ?? 'anna-ciok-print-assets';
}

export interface R2Result {
  ok: boolean;
  error?: string;
}

function describeFailure(res: ReturnType<typeof spawnSync>): string {
  return (
    (typeof res.stderr === 'string' ? res.stderr.trim() : '') ||
    res.error?.message ||
    `exit ${res.status ?? 'null'}`
  );
}

/**
 * Download `{bucket}/{key}` to `destPath`. `ok:false` means the object is
 * absent OR the request failed (auth/network) — Wrangler 4.x does not give a
 * machine-readable "not found", so callers must treat a failed get as "cannot
 * prove the object is present" and fail closed, never as a definitive delete.
 */
export function r2GetToFile(bucket: string, key: string, destPath: string): R2Result {
  const res = spawnSync(
    'npx',
    ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', destPath],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  return res.status === 0 ? { ok: true } : { ok: false, error: describeFailure(res) };
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
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  return res.status === 0 ? { ok: true } : { ok: false, error: describeFailure(res) };
}
