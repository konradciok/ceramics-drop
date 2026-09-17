import { supabaseFromEnv } from '@/lib/supabase';
import type { AssetJobMessage } from './enqueue';

// print_asset_uploads columns this stub actually needs — subset of
// uploads-mapping.ts's UploadRow.
type UploadRowForProcessing = {
  id: string;
  status: 'pending' | 'confirmed';
  r2_key: string;
};

/**
 * Queue-name routing predicate for worker.ts's queue() handler — mirrors
 * src/server/fulfilment/dlq.ts's isDlqQueue (a suffix/prefix-based match
 * rather than an exact one, so it works across the prod/preview and
 * primary/DLQ queue-name variants declared in wrangler.jsonc: 'print-asset-jobs',
 * 'print-asset-jobs-preview', 'print-asset-jobs-dlq',
 * 'print-asset-jobs-preview-dlq'). worker.ts checks this BEFORE the generic
 * isDlqQueue check so an asset-jobs DLQ message is never routed into the
 * fulfilment DLQ handler, which assumes a FulfilmentJobMessage body shape.
 */
export function isAssetJobsQueue(queueName: string): boolean {
  return queueName.startsWith('print-asset-jobs');
}

/**
 * Queue consumer for ASSET_JOBS_QUEUE — the per-message handler worker.ts's
 * queue() branch calls into. Mirrors src/server/fulfilment/process-job.ts's
 * CAS-claim / fail-or-finalize structure directly (per the plan's own
 * instruction to copy that structure rather than reaching for Durable
 * Objects), stubbed per this phase's explicit scope: it claims the row,
 * verifies its ACTUAL prerequisites exist (the upload row is 'confirmed', the
 * uploaded object is still in R2), and marks a stub terminal state — NO Sharp,
 * NO derivative generation, NO call into src/server/print-assets/derivatives.ts.
 * Phase 3 (a separate, later task) replaces steps 3+ below with the real
 * Container-based processor; the claim/fail/finalize scaffolding around it
 * does not need to change for that.
 */
export async function processAssetJob(
  msg: AssetJobMessage,
  env: CloudflareEnv,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: ExecutionContext,
): Promise<void> {
  const { jobId, uploadId } = msg;
  // C-2 (mirrors fulfilment/process-job.ts): the queue consumer runs outside
  // the request AsyncLocalStorage, so getSupabaseAdmin() (via
  // getCloudflareContext()) would throw here. Build the service-role client
  // from the explicit env, exactly like the existing fulfilment queue
  // consumer and worker.ts's cron/scheduled handlers do.
  const supabase = supabaseFromEnv(env);
  const now = () => new Date().toISOString();

  // Throws → queue retry; used for every write whose loss would strand the job.
  const failJob = async (status: 'failed_retryable' | 'failed_action_required', lastError: string, attempts: number) => {
    const { error } = await supabase
      .from('print_asset_jobs')
      .update({ status, last_error: lastError, attempts, updated_at: now() })
      .eq('id', jobId);
    if (error) throw error;
  };

  // 1. Claim the job with a single conditional update (no read-then-write
  // race) — same claimable-status set shape as fulfilment_jobs's
  // ['queued', 'failed_retryable', 'fulfilment_submitting'] (its own
  // in-flight state stays claimable so a crash mid-processing can retry).
  const { data: job, error: claimErr } = await supabase
    .from('print_asset_jobs')
    .update({ status: 'processing', updated_at: now() })
    .eq('id', jobId)
    .in('status', ['queued', 'failed_retryable', 'processing'])
    .select('attempts')
    .maybeSingle();

  if (claimErr) throw claimErr; // queue retries
  if (!job) return; // already terminal / duplicate delivery

  const attempts = ((job as { attempts: number }).attempts ?? 0) + 1;

  // 2. Load the upload row this job is processing — a stub processor still
  // needs its input to genuinely exist and be in the expected state; this is
  // deliberately the ONLY validation it performs (no Sharp, no derivative
  // decode of the bytes).
  const { data: upload, error: uploadErr } = await supabase
    .from('print_asset_uploads')
    .select('id, status, r2_key')
    .eq('id', uploadId)
    .maybeSingle();

  if (uploadErr) throw uploadErr; // transient DB error → queue retry
  if (!upload) {
    await failJob('failed_action_required', `upload ${uploadId} not found`, attempts);
    return;
  }
  const uploadRow = upload as UploadRowForProcessing;
  if (uploadRow.status !== 'confirmed') {
    await failJob('failed_action_required', `upload ${uploadId} is not confirmed (status=${uploadRow.status})`, attempts);
    return;
  }

  // 3. Confirm the uploaded object still exists in R2 — the same existence
  // check uploads-confirm.ts performed at confirm time (still no
  // Sharp/derivative decode, just an R2 HEAD).
  if (!env.PRINT_ASSETS) {
    await failJob('failed_action_required', 'PRINT_ASSETS binding missing — cannot verify uploaded object', attempts);
    return;
  }
  let object;
  try {
    object = await env.PRINT_ASSETS.head(uploadRow.r2_key);
  } catch (e) {
    await failJob('failed_retryable', `R2 head failed for ${uploadRow.r2_key}: ${String(e)}`, attempts);
    throw e; // queue retries
  }
  if (!object) {
    await failJob('failed_action_required', `R2 object missing for upload ${uploadId} (${uploadRow.r2_key})`, attempts);
    return;
  }

  // 4. STUB terminal success. Phase 3 replaces this step with the real
  // Container-based Sharp derivative pipeline; `asset_id` stays null here —
  // nothing downstream reads a completed stub job's asset_id yet. Same
  // finalize-CAS-may-lose-the-race tolerance as fulfilment/process-job.ts: a
  // concurrent delivery of the same message could have finalized this job
  // first, so 0 rows updated is logged, not thrown.
  const { data: finalized, error: doneErr } = await supabase
    .from('print_asset_jobs')
    .update({ status: 'completed', attempts, updated_at: now() })
    .eq('id', jobId)
    .in('status', ['processing'])
    .select('id')
    .maybeSingle();
  if (doneErr) throw doneErr;
  if (!finalized) {
    console.warn(`processAssetJob: job ${jobId} finalized by a concurrent delivery — leaving its status untouched`);
  }
}
