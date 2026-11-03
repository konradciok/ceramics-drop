import type { SupabaseClient } from '@supabase/supabase-js';

// print_asset_jobs row shape (supabase/migrations/20260917170000_print_asset_jobs.sql).
// Mirrors src/server/fulfilment/enqueue.ts's structure directly, per the plan's
// own instruction ("copy this structure directly rather than reaching for
// Durable Objects"). See that migration's header comment for the deliberate,
// disclosed deviations from fulfilment_jobs.
export interface PrintAssetJobRow {
  id: string;
  upload_id: string;
  asset_id: string | null;
  asset_revision: number;
  status: 'queued' | 'processing' | 'completed' | 'failed_retryable' | 'failed_action_required';
  attempts: number;
  idempotency_key: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Message shape sent to ASSET_JOBS_QUEUE. Deliberately minimal — like
 * FulfilmentJobMessage (src/server/prodigi/types.ts), process-job.ts re-reads
 * everything else it needs from the DB rather than trusting the queue
 * payload for anything beyond routing to the right row.
 */
export interface AssetJobMessage {
  jobId: string;
  uploadId: string;
}

export interface EnqueueAssetJobInput {
  uploadId: string;
  /** Snapshot of print_asset_uploads.revision at enqueue time — see the migration's module comment. */
  assetRevision: number;
}

/** Deterministic per-upload idempotency key — see the migration's module comment on why no separate partial-unique index on upload_id is needed. */
export function buildAssetJobIdempotencyKey(uploadId: string): string {
  return `print-asset-job:${uploadId}:v1`;
}

/**
 * Persist a print_asset_jobs row (idempotent per upload: a second call for the
 * same uploadId recovers and re-sends for the SAME row rather than creating a
 * duplicate — mirrors src/server/fulfilment/enqueue.ts's
 * upsert-then-recover-on-conflict shape) and send its queue message.
 *
 * Deliberate deviation from fulfilment/enqueue.ts: this does NOT default to
 * resolving its own Supabase client (no `getSupabaseAdmin()` fallback) — the
 * CmsApi handler calling this (jobs-create.ts) must never call
 * adminSupabase()/getCloudflareContext() (Task 5's regression: that throws
 * outside the request AsyncLocalStorage CmsApi's WorkerEntrypoint runs in), so
 * the caller always passes `ctx.supabase` explicitly instead.
 */
export async function enqueueAssetJob(
  supabase: SupabaseClient,
  env: Pick<CloudflareEnv, 'ASSET_JOBS_QUEUE'>,
  input: EnqueueAssetJobInput,
): Promise<PrintAssetJobRow> {
  const idempotencyKey = buildAssetJobIdempotencyKey(input.uploadId);

  const { data, error } = await supabase
    .from('print_asset_jobs')
    .upsert(
      {
        id: crypto.randomUUID(),
        upload_id: input.uploadId,
        asset_revision: input.assetRevision,
        idempotency_key: idempotencyKey,
        status: 'queued',
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`enqueueAssetJob: job upsert failed for upload ${input.uploadId}: ${error.message}`);
  }

  let job = data as PrintAssetJobRow | null;
  if (!job) {
    // Conflict path: a row already exists under this deterministic key —
    // recover it so the queue message can still be (re)sent. Mirrors
    // fulfilment/enqueue.ts's identical "recover on conflict" shape.
    const { data: existing, error: selErr } = await supabase
      .from('print_asset_jobs')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .single();
    if (selErr || !existing) {
      throw new Error(
        `enqueueAssetJob: job row missing after conflict for upload ${input.uploadId}: ${selErr?.message ?? 'not found'}`,
      );
    }
    job = existing as PrintAssetJobRow;
  }

  await sendAssetJobMessage(env, { jobId: job.id, uploadId: input.uploadId });
  return job;
}

/**
 * Send (or re-send, for a retry) the queue message for an existing job row.
 * Throws when the binding is missing — CmsApi route handlers have no
 * ExecutionContext/waitUntil in scope (see request-handler.ts's
 * HandlerContext), so unlike fulfilment/enqueue.ts's local-dev
 * inline-processing fallback there is nowhere to run one; failing closed (a
 * 500 surfaced to the client) is the only honest option here, matching
 * uploads-mapping.ts's resolveR2PresignCredentials's fail-closed posture for a
 * missing binding/secret.
 */
export async function sendAssetJobMessage(
  env: Pick<CloudflareEnv, 'ASSET_JOBS_QUEUE'>,
  msg: AssetJobMessage,
): Promise<void> {
  if (!env.ASSET_JOBS_QUEUE) {
    throw new Error('ASSET_JOBS_QUEUE binding is missing — cannot enqueue asset job');
  }
  await env.ASSET_JOBS_QUEUE.send(msg);
}
