/**
 * R2 helpers for the Phase 2b print-asset operator scripts.
 *
 * Bound `R2Bucket` objects (get/put/head) only exist inside the Workers
 * runtime; these operator scripts run in Node, so they shell out to the
 * Wrangler CLI exactly as scripts/print-asset-inventory.ts does. Wrangler 4.x
 * has no `r2 object head`, so existence + content verification both go through
 * `r2 object get --file` (streamed to disk, never held whole in a JS Buffer).
 *
 * Two write paths, deliberately different:
 *   - `r2PutIfAbsent` — the ONLY fulfilment write. A conditional S3 PUT
 *     (`If-None-Match: *`) against the R2 S3 API so a concurrent second upload
 *     never silently overwrites an immutable content-addressed key (returns
 *     `exists` on the 412). Needs the three CLI-only S3 credentials.
 *   - `r2PutMutable` — Wrangler `r2 object put`, used ONLY by gallery
 *     generation, whose public slot keys are intentionally replaceable.
 * `r2GetToFile` and the bucket-name resolution are read-only.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { AwsClient } from 'aws4fetch';
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
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: WRANGLER_TIMEOUT_MS, shell: process.platform === 'win32' },
  );
  if (res.status === 0) return { ok: true };
  const error = describeFailure(res);
  return { ok: false, kind: classifyR2GetFailure(error), error };
}

/**
 * Upload `filePath` to `{bucket}/{key}` with an explicit `--content-type`
 * (`wrangler r2 object put` does not infer it from the key, so the caller's
 * contentType is the contract). This is a MUTABLE, last-writer-wins put — it
 * overwrites whatever occupies the key. Reserved for gallery generation, whose
 * `prints/{productId}/gallery/{slot}/` keys are intentionally replaceable.
 * Fulfilment derivatives must use `r2PutIfAbsent` instead (never overwrite an
 * immutable content-addressed key).
 */
export function r2PutMutable(
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
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: WRANGLER_TIMEOUT_MS, shell: process.platform === 'win32' },
  );
  return res.status === 0 ? { ok: true } : { ok: false, error: describeFailure(res) };
}

// ── Conditional fulfilment write — S3 If-None-Match: * ────────────────────────

/** The three CLI-only S3 credential values `r2PutIfAbsent` needs (never logged). */
export interface R2ConditionalCredentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The exact env var names for the conditional-put S3 credentials. */
const R2_S3_CREDENTIAL_VARS = [
  'R2_S3_ACCOUNT_ID',
  'R2_S3_ACCESS_KEY_ID',
  'R2_S3_SECRET_ACCESS_KEY',
] as const;

/**
 * Read + trim the three CLI-only S3 credentials for the conditional fulfilment
 * PUT from the merged env stack (`loadLocalEnv()`). Throws a single error naming
 * ONLY the missing/blank variable names — never any credential value — so the
 * secrets can never reach a log line or stack trace. Resolved lazily by the
 * upload script immediately before the first create attempt, so dry-runs and
 * fully-reused revisions never require these to be set.
 */
export function resolveR2ConditionalCredentials(
  env: Record<string, string | undefined>,
): R2ConditionalCredentials {
  const trimmed = R2_S3_CREDENTIAL_VARS.map((name) => (env[name] ?? '').trim());
  const missing = R2_S3_CREDENTIAL_VARS.filter((_, i) => trimmed[i] === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing R2 S3 credential(s): ${missing.join(', ')}. Set them in .dev.vars / .env.local / --env-file ` +
        'to perform conditional fulfilment uploads.',
    );
  }
  const [accountId, accessKeyId, secretAccessKey] = trimmed;
  return { accountId, accessKeyId, secretAccessKey };
}

interface ConditionalPutInput {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  filePath: string;
  contentType: string;
  sha256: string;
}

/**
 * Create `{bucket}/{key}` via a conditional S3 PUT (`If-None-Match: *`) against
 * the R2 S3 API, streaming the file from disk (never buffered whole). The
 * conditional header makes the write CREATE-ONLY: R2 returns 412 when an object
 * already exists at the key, so a racing second upload gets `exists` instead of
 * silently overwriting an immutable content-addressed derivative. The provided
 * `sha256` is sent as `X-Amz-Content-Sha256`, so aws4fetch signs without reading
 * the stream. Any non-412, non-2xx status throws (the operator re-runs).
 */
export async function r2PutIfAbsent(
  input: ConditionalPutInput,
  client: Pick<AwsClient, 'fetch'> = new AwsClient({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    service: 's3',
    region: 'auto',
    // Keep retries at 0: a consumed file stream cannot be replayed safely, so
    // aws4fetch must not retry. The operator reruns the idempotent upload
    // command after a transient failure.
    retries: 0,
  }),
): Promise<'created' | 'exists'> {
  const encodedKey = input.key.split('/').map(encodeURIComponent).join('/');
  const url = `https://${input.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(input.bucket)}/${encodedKey}`;
  const stream = Readable.toWeb(fs.createReadStream(input.filePath));
  // A streamed body has no inherent length, so fetch/undici defaults to
  // chunked transfer-encoding — R2's S3 API rejects that for PUT with
  // 411 MissingContentLength. Declare it explicitly from the file's real size.
  const contentLength = fs.statSync(input.filePath).size;
  const response = await client.fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': input.contentType,
      'content-length': String(contentLength),
      'if-none-match': '*',
      'x-amz-content-sha256': input.sha256,
    },
    body: stream as BodyInit,
  });
  if (response.status === 412) return 'exists';
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`R2 conditional PUT failed (${response.status}): ${detail}`);
  }
  return 'created';
}
