import type { SupabaseClient } from '@supabase/supabase-js';
import { AwsClient } from 'aws4fetch';
import { SITE_URL } from '@/lib/site';
import type { AssetResponse } from './types';

// ---------------------------------------------------------------------------
// print_asset_uploads row shape (supabase/migrations/20260917160000_print_asset_uploads.sql)
// ---------------------------------------------------------------------------

export type UploadRow = {
  id: string;
  filename: string;
  content_type: 'image/jpeg' | 'image/png';
  declared_byte_size: number;
  ratio: string;
  // Task 12: required on every row insertUploadRow writes from here on
  // (supabase/migrations/20260917190000_print_asset_uploads_product_required.sql
  // tightens the column itself to NOT NULL). Typed as a plain string, not
  // string | null, for that reason — process-job.ts's own narrower
  // UploadRowForProcessing type keeps `product_id: string | null` on purpose,
  // as defense-in-depth for any pre-existing/malformed row the DB constraint
  // doesn't retroactively cover.
  product_id: string;
  r2_key: string;
  status: 'pending' | 'confirmed';
  revision: number;
  confirmed_byte_size: number | null;
  confirmed_content_type: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
};

/** Only ever produced by a successful confirmUploadRow — see mapConfirmedUploadToAsset. */
export type ConfirmedUploadRow = UploadRow & { status: 'confirmed' };

// ---------------------------------------------------------------------------
// R2 object key — id-addressed (see the migration's r2_key comment for why
// this cannot be content-addressed like print_fulfilment_assets.r2_key: the
// sha256 is only knowable after the client's PUT, not at intent time).
// ---------------------------------------------------------------------------

export function buildUploadR2Key(id: string, contentType: 'image/jpeg' | 'image/png'): string {
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  return `uploads/${id}.${ext}`;
}

// ---------------------------------------------------------------------------
// R2 presigned PUT — R2 bucket BINDINGS (env.PRINT_ASSETS) expose only
// get/head/put and have no createSignedUrl (see src/lib/print-assets.ts's
// header comment) — that limitation is why fulfilment reads go through the
// HMAC-signed /api/print-assets/[id] proxy instead of a presigned R2 URL.
// A client PUT is the opposite direction (bytes flowing IN, straight to R2,
// never through this Worker) and genuinely needs a real presigned URL, which
// only R2's S3-compatible API can issue — via SigV4 query-string signing
// (`signQuery: true`), the same aws4fetch AwsClient this repo's
// scripts/lib/r2.ts already uses for its conditional fulfilment PUT (S3
// credentials, not the binding). Deliberately NOT imported from
// scripts/lib/r2.ts here: that module also pulls in `node:fs`/`node:child_process`
// for its Wrangler-CLI helpers, which have no place in Worker-bundled
// src/server/ code (the exact class of hazard Task 8's derivatives.ts/Sharp
// note flags) — so this is a small, self-contained, Worker-safe rebuild of
// just the presigning half.
// ---------------------------------------------------------------------------

// 15 minutes: long enough for an admin to receive the intent and start the
// PUT, short enough that a leaked URL is not a long-lived bearer credential —
// it authorizes exactly one PUT into one id-addressed key, not open-ended
// reads (contrast src/lib/print-assets.ts's 48h PRINT_ASSET_TTL_SECS, which
// signs GETs Prodigi may fetch much later).
export const UPLOAD_PRESIGN_TTL_SECS = 15 * 60;

// Must match wrangler.jsonc's r2_buckets[].bucket_name for the PRINT_ASSETS
// binding — same default scripts/lib/r2.ts's resolveBucketName documents for
// the identical reason (no PRINT_ASSETS_BUCKET override plumbed through here;
// add one if a non-default bucket is ever needed for this path).
const PRINT_ASSETS_BUCKET_NAME = 'anna-ciok-print-assets';

export interface R2PresignCredentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Same three env var names scripts/lib/r2.ts's resolveR2ConditionalCredentials
 *  reads for the CLI upload operator — see cloudflare-env.d.ts's R2_S3_* comment. */
const R2_PRESIGN_CREDENTIAL_VARS = ['R2_S3_ACCOUNT_ID', 'R2_S3_ACCESS_KEY_ID', 'R2_S3_SECRET_ACCESS_KEY'] as const;

/**
 * Reads + trims the three R2 S3 presigning credentials from the Worker env.
 * Throws a single error naming ONLY the missing/blank variable names — never
 * any credential value — mirroring resolveR2ConditionalCredentials's exact
 * discipline. Left optional in CloudflareEnv (fail-closed: a misconfigured
 * deployment 500s POST /v1/uploads rather than ever silently skipping the
 * presign).
 */
export function resolveR2PresignCredentials(
  env: Partial<Record<(typeof R2_PRESIGN_CREDENTIAL_VARS)[number], string>>,
): R2PresignCredentials {
  const trimmed = {
    R2_S3_ACCOUNT_ID: (env.R2_S3_ACCOUNT_ID ?? '').trim(),
    R2_S3_ACCESS_KEY_ID: (env.R2_S3_ACCESS_KEY_ID ?? '').trim(),
    R2_S3_SECRET_ACCESS_KEY: (env.R2_S3_SECRET_ACCESS_KEY ?? '').trim(),
  };
  const missing = R2_PRESIGN_CREDENTIAL_VARS.filter((name) => trimmed[name] === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing R2 S3 credential(s) for upload presigning: ${missing.join(', ')}. Set them via wrangler secret ` +
        "(the same values scripts/lib/r2.ts's CLI credentials use).",
    );
  }
  return {
    accountId: trimmed.R2_S3_ACCOUNT_ID,
    accessKeyId: trimmed.R2_S3_ACCESS_KEY_ID,
    secretAccessKey: trimmed.R2_S3_SECRET_ACCESS_KEY,
  };
}

/**
 * Builds a SigV4 query-string-signed PUT URL against R2's S3-compatible API
 * (`https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key}`), the same
 * endpoint shape scripts/lib/r2.ts's r2PutIfAbsent targets. The client PUTs
 * its file bytes straight to this URL — never through this Worker — with no
 * extra required headers (content-type is intentionally left unsigned so a
 * plain browser `fetch(url, {method:'PUT', body: file})` works without
 * needing to reproduce an exact header set; the actual content-type/size are
 * verified independently, against the real R2 object, by uploads-confirm.ts).
 * `client` is injectable (same pattern as r2PutIfAbsent) purely for testing —
 * `.sign()` performs no network I/O, so the real AwsClient is cheap to use
 * directly in tests too.
 */
export async function presignUploadPutUrl(
  creds: R2PresignCredentials,
  key: string,
  expiresInSecs: number = UPLOAD_PRESIGN_TTL_SECS,
  bucket: string = PRINT_ASSETS_BUCKET_NAME,
  client: Pick<AwsClient, 'sign'> = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: 's3',
    region: 'auto',
  }),
): Promise<string> {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`https://${creds.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`);
  url.searchParams.set('X-Amz-Expires', String(expiresInSecs));
  const signed = await client.sign(url.toString(), { method: 'PUT', aws: { signQuery: true } });
  return signed.url;
}

// ---------------------------------------------------------------------------
// Row <-> wire mapping — pure, no I/O.
// ---------------------------------------------------------------------------

export type UploadIntentResponse = { id: string; assetId: string; uploadUrl: string; expiresAt: string };

/**
 * assetId mirrors id in this phase: nothing downstream of confirm yet
 * materializes a distinct asset identity (that is Phase 2+'s job pipeline,
 * out of scope here) — one upload row IS the one prospective asset it
 * describes, so there is nothing else for assetId to name yet.
 */
export function mapUploadRowToIntent(row: Pick<UploadRow, 'id' | 'expires_at'>, uploadUrl: string): UploadIntentResponse {
  return { id: row.id, assetId: row.id, uploadUrl, expiresAt: row.expires_at };
}

/**
 * A confirmed upload has no processing pipeline yet (Phase 2+), so it is
 * always reported as the contract's "uploaded" state (== "awaiting
 * processing" per the plan) with no usages and no error. `url` is a stable,
 * predictable path this API does not yet serve (no derivative/original
 * serving route exists in this phase — building one is out of scope; see the
 * task brief's Phase 1 boundary) rather than the raw r2_key/bucket, so a
 * later phase can wire a real handler behind the exact same shape without
 * another contract-facing change.
 */
export function mapConfirmedUploadToAsset(row: ConfirmedUploadRow): AssetResponse {
  return {
    id: row.id,
    name: row.filename,
    revision: row.revision,
    status: 'uploaded',
    ratio: row.ratio,
    url: `${SITE_URL}/api/print-assets/uploads/${row.id}`,
    usages: [],
    error: '',
  };
}

// ---------------------------------------------------------------------------
// I/O — always over the handler context's ctx.supabase (built by
// request-handler.ts's deps.makeSupabase(env)). Never adminSupabase() /
// getCloudflareContext(): CmsApi is a WorkerEntrypoint invoked over a service
// binding and is never wrapped by runWithCloudflareRequestContext, so those
// would throw in production (see request-handler.test.ts's Task 5 regression).
// ---------------------------------------------------------------------------

export type NewUploadInput = {
  id: string;
  filename: string;
  contentType: 'image/jpeg' | 'image/png';
  bytes: number;
  ratio: string;
  productId: string;
  r2Key: string;
  createdBy: string;
  expiresAt: string;
};

export async function insertUploadRow(supabase: SupabaseClient, input: NewUploadInput): Promise<UploadRow> {
  const { data, error } = await supabase
    .from('print_asset_uploads')
    .insert({
      id: input.id,
      filename: input.filename,
      content_type: input.contentType,
      declared_byte_size: input.bytes,
      ratio: input.ratio,
      product_id: input.productId,
      r2_key: input.r2Key,
      created_by: input.createdBy,
      expires_at: input.expiresAt,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as UploadRow;
}

export async function getUploadRowById(supabase: SupabaseClient, id: string): Promise<UploadRow | null> {
  const { data, error } = await supabase.from('print_asset_uploads').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as UploadRow | null) ?? null;
}

export type ObservedUploadMetadata = { byteSize: number; contentType: string | undefined };

/**
 * CAS confirm: `where id = $1 and revision = $2` — matches 0 rows (returns
 * null) both when the id does not exist and when the row's revision has
 * already moved past `expectedRevision` (already confirmed by a concurrent
 * request). The caller (uploads-confirm.ts) distinguishes those two cases via
 * its own preceding getUploadRowById read, exactly as content-publication.ts
 * distinguishes NOT_FOUND from REVISION_CONFLICT.
 */
export async function confirmUploadRow(
  supabase: SupabaseClient,
  id: string,
  expectedRevision: number,
  observed: ObservedUploadMetadata,
): Promise<UploadRow | null> {
  const { data, error } = await supabase
    .from('print_asset_uploads')
    .update({
      status: 'confirmed',
      revision: 1,
      confirmed_byte_size: observed.byteSize,
      confirmed_content_type: observed.contentType ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('revision', expectedRevision)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return (data as UploadRow | null) ?? null;
}
