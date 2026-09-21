import { supabaseFromEnv } from '@/lib/supabase';
import { captureWorkerAlert } from '@/lib/worker-sentry';
import type { StagedAssetRow } from '@/lib/print-assets-publish';
import type { AssetJobMessage } from './enqueue';
import { PRINT_ASSET_PROCESSOR_NAME } from './container-names';
import type { RenderInput, RenderResult } from './container-render';
import { assetRevisionForUpload, isPrintRatio, loadActivePrintVariants, selectProfilesForRatio } from './profiles';
import { promoteStagedAssets } from './promote';

// print_asset_uploads columns this consumer needs — subset of
// uploads-mapping.ts's UploadRow, plus `product_id`
// (supabase/migrations/20260917180000_print_asset_uploads_product.sql).
type UploadRowForProcessing = {
  id: string;
  status: 'pending' | 'confirmed';
  r2_key: string;
  ratio: string;
  content_type: 'image/jpeg' | 'image/png';
  // NOT NULL since Task 12 (see the product migration above); the runtime
  // guard below is kept anyway — the column is only as good as the row that
  // reached it, and this consumer reads rows it did not write.
  product_id: string;
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
 * Job-wide render deadline (CodeRabbit PR #318 round 2, Finding 2): an
 * absolute budget shared across EVERY profile of one job, not a fresh timeout
 * per profile. `selectProfilesForRatio` can return more than one profile, each
 * rendered sequentially through its own `RENDER_TIMEOUT_MS`-bounded (10 min)
 * RPC — two slow profiles could together exceed Cloudflare Queues' Queue
 * Consumer duration limit (15 minutes wall-clock; verified against
 * developers.cloudflare.com/workers/platform/limits/ rather than assumed) and
 * get hard-killed mid-RPC. When that happens the queue handler never runs its
 * `.then()/.catch()`, so it can call neither `failJob` nor `ack`/`retry` — the
 * row is stuck `processing` until this same claim/lease logic reclaims it (see
 * `JOB_LEASE_MS` below).
 *
 * 12 minutes leaves 3 minutes of headroom under the 15-minute hard limit for
 * everything OUTSIDE the profile loop this budget bounds — the claim, the
 * upload/variant lookups, the R2 head, and the post-loop staging
 * upsert/read-back/finalize — all of which are ordinary fast DB/R2 calls, not
 * multi-minute container RPCs.
 */
export const JOB_DEADLINE_MS = 12 * 60 * 1000;

/**
 * A profile whose remaining budget is at or below this floor is not worth
 * starting — even a healthy container needs more than a few seconds to
 * confirm readiness and begin rendering. Below it, process-job.ts fails the
 * profile CONTAINER_TIMEOUT/retryable WITHOUT calling the container at all
 * (Finding 2's fix step 3), rather than spending an RPC on a request that has
 * no realistic chance to finish before the job-wide deadline anyway.
 */
export const MIN_PROFILE_BUDGET_MS = 10_000;

/**
 * Extra time, on top of `JOB_DEADLINE_MS`, a claimed row's lease stays valid
 * before another worker may reclaim it (Finding 1). Deliberately DERIVED from
 * the same render-deadline budget rather than a second, unrelated magic
 * number (Finding 2's fix step 4: "how long can this job legitimately run" is
 * one concept) — it just adds room for the post-loop staging/finalize work
 * that happens AFTER the profile loop's own deadline has been spent. The
 * total (14 min) stays just under the 15-minute hard kill, so a worker that
 * really does get hard-killed leaves a lease that is already at (or almost
 * at) expiry, not one a healthy reclaimer has to wait a further margin out.
 */
const LEASE_GRACE_MS = 2 * 60 * 1000;
export const JOB_LEASE_MS = JOB_DEADLINE_MS + LEASE_GRACE_MS;

/**
 * Queue consumer for ASSET_JOBS_QUEUE.
 *
 * Task 10 (Phase 2) built the durable-job scaffolding around this: the
 * single-statement CAS claim, the attempts/lease bookkeeping, the
 * failed_retryable-vs-failed_action_required split, and the rethrow-to-retry
 * contract that feeds Cloudflare Queues' backoff and the DLQ. Task 11
 * (Phase 3) replaced the stub with the real container-based render pipeline.
 * Task G (CodeRabbit PR #318 round 2) adds the lease/fencing token to the
 * claim/fail/finalize CAS (Finding 1) and the job-wide render deadline
 * (Finding 2) — see the module-level doc comments on `JOB_DEADLINE_MS` and
 * `JOB_LEASE_MS` above.
 *
 * ⚠️  Sharp boundary: this file runs as a Workers queue consumer in the V8
 * isolate. It must NEVER import src/server/print-assets/derivatives.ts (or
 * anything else that reaches `sharp`). The only Sharp in this pipeline lives
 * behind the container's HTTP port.
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
  // Finding 1's fencing token: minted once, unconditionally, up front. Only
  // ever WRITTEN to the row by the claim update below (and only takes effect
  // if that claim actually matches a row) — generating it here purely lets
  // `failJob` close over a single stable value for the rest of this
  // invocation's lifetime instead of threading it through every call site.
  const leaseToken = crypto.randomUUID();

  // Throws → queue retry; used for every write whose loss would strand the job.
  const failJob = async (status: 'failed_retryable' | 'failed_action_required', lastError: string, attempts: number) => {
    // Finding 1 fencing: this write only lands if `leaseToken` is STILL the
    // row's current lease — i.e. nobody has reclaimed it out from under us
    // since our claim. A worker whose lease has since expired (its own
    // invocation ran long, e.g. past `JOB_DEADLINE_MS`, and a fresh claim
    // reclaimed the row before this write happened) matches 0 rows here.
    const { data: updated, error } = await supabase
      .from('print_asset_jobs')
      .update({ status, last_error: lastError, attempts, updated_at: now() })
      .eq('id', jobId)
      .eq('lease_token', leaseToken)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      // Same tolerant 0-rows-matched shape as the finalize CAS below — a
      // fenced-out write is not this invocation's job to fix or alert on; the
      // worker that actually holds the lease now owns this job's outcome.
      console.warn(
        `processAssetJob: failJob(${status}) for job ${jobId} no-op — lease_token no longer matches (row reclaimed by another worker)`,
      );
      return;
    }

    // failed_action_required is TERMINAL and never retried — this function
    // does not throw for it, so worker.ts's queue() branch acks the message
    // immediately and it never reaches the ASSET_JOBS_QUEUE DLQ (which only
    // ever sees retries-exhausted/thrown-error failures — see
    // handleAssetJobsDlqBatch in worker.ts). Without a fulfilment-style
    // sweepFailedActionJobs cron (deliberately out of scope for this phase —
    // see the task report), this synchronous alert is the ONLY
    // operator-visible signal for this failure class, so it fires right here,
    // once, at the moment of the terminal transition. Same
    // log-then-Sentry-capture shape as handleAssetJobsDlqBatch for
    // consistency. `failed_retryable` deliberately does NOT alert here: it
    // still gets its normal chance to retry/backoff through the existing
    // queue machinery, which already alerts on DLQ exhaustion.
    if (status === 'failed_action_required') {
      console.error(JSON.stringify({ event: 'asset_job_failed_action_required', jobId, uploadId, lastError, attempts }));
      await captureWorkerAlert(env, {
        message: 'asset_job_failed_action_required',
        level: 'error',
        extra: { jobId, uploadId, lastError, attempts },
      });
    }
  };

  // 1. Claim the job with a single conditional update (no read-then-write
  // race). Finding 1: reclaim EITHER an unconditionally-claimable row
  // (`queued`/`failed_retryable`, same as before) OR a `processing` row whose
  // lease has EXPIRED — CodeRabbit's own persistent-learnings note: "a
  // claim-with-lease queue must reclaim only expired processing rows". This is
  // the crash-recovery path for a worker that died mid-job; it is
  // deliberately preserved, just lease-gated instead of unconditional.
  // Supabase-js needs `.or()` for the compound OR-with-nested-AND condition —
  // same syntax this codebase already uses in
  // src/server/fulfilment/reconcile-orders.ts's `sweepStaleProdigiOrders`
  // (`.or('a.lt.X,and(b.is.null,c.lt.X)')`).
  const nowIso = now();
  const leaseExpiresAt = new Date(Date.now() + JOB_LEASE_MS).toISOString();
  const { data: job, error: claimErr } = await supabase
    .from('print_asset_jobs')
    .update({ status: 'processing', updated_at: nowIso, lease_token: leaseToken, lease_expires_at: leaseExpiresAt })
    .eq('id', jobId)
    .or(`status.eq.queued,status.eq.failed_retryable,and(status.eq.processing,lease_expires_at.lt.${nowIso})`)
    .select('attempts')
    .maybeSingle();

  if (claimErr) throw claimErr; // queue retries
  if (!job) {
    // The claim missed. Two very different reasons collapse to the same "0
    // rows matched" result, and they must NOT be handled the same way:
    //   - the row is genuinely terminal (completed / failed_action_required)
    //     or gone — this delivery is a harmless duplicate, ack and stop.
    //   - the row is still `processing` with an ACTIVE lease — someone else
    //     (possibly a still-healthy earlier attempt of THIS SAME message,
    //     possibly the crash this very delivery exists to recover from) may
    //     still be working it. Acking here would be wrong: once acked, Cloudflare
    //     Queues never redelivers this message again, so if the active-lease
    //     holder really did crash, NOTHING would ever arrive to reclaim the row
    //     after its lease expires (see stranded-job-alert.ts's
    //     STRANDED_ASSET_JOB_STATUSES comment, which deliberately excludes
    //     `processing` because recovering it is THIS claim/lease logic's job,
    //     not the cron sweep's). Throwing here instead makes worker.ts retry
    //     with backoff, giving a later delivery the chance to see either a
    //     terminal row (ack) or an expired lease (reclaim) — and if the lease
    //     holder is healthy and finishes normally, a later retry simply lands
    //     on the terminal case.
    const { data: current, error: lookupErr } = await supabase
      .from('print_asset_jobs')
      .select('status')
      .eq('id', jobId)
      .maybeSingle();
    if (lookupErr) throw lookupErr; // queue retries
    if ((current as { status: string } | null)?.status === 'processing') {
      throw new Error(`asset job ${jobId} claim missed — another worker's lease on it is still active`);
    }
    return; // terminal / duplicate delivery
  }

  const attempts = ((job as { attempts: number }).attempts ?? 0) + 1;

  // 2. Load the upload row this job is processing.
  const { data: upload, error: uploadErr } = await supabase
    .from('print_asset_uploads')
    .select('id, status, r2_key, ratio, content_type, product_id')
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
  // Task 12 closed the product-association gap this phase originally
  // inherited: POST /v1/uploads now REQUIRES productId, validates it against
  // the active print variants, and print_asset_uploads.product_id is NOT NULL
  // (see the column's migration header). This check is therefore defensive
  // rather than load-bearing — deliberately kept, because
  // print_fulfilment_assets.product_id is NOT NULL and this consumer reads
  // rows it did not write (a pre-migration backfill, a direct DB write, a
  // future nullable relaxation). Fail loudly rather than "complete" a job that
  // can produce no asset row.
  if (!uploadRow.product_id) {
    await failJob(
      'failed_action_required',
      `upload ${uploadId} has no product_id — cannot stage print_fulfilment_assets rows for it`,
      attempts,
    );
    return;
  }
  if (!isPrintRatio(uploadRow.ratio)) {
    await failJob('failed_action_required', `upload ${uploadId} declares unknown ratio "${uploadRow.ratio}"`, attempts);
    return;
  }

  // 3. Bindings. Both are fail-closed config faults an operator must fix, not
  // conditions a retry can clear.
  if (!env.PRINT_ASSETS) {
    await failJob('failed_action_required', 'PRINT_ASSETS binding missing — cannot verify uploaded object', attempts);
    return;
  }
  if (!env.PRINT_ASSET_PROCESSOR) {
    await failJob('failed_action_required', 'PRINT_ASSET_PROCESSOR container binding missing — cannot process derivatives', attempts);
    return;
  }

  // 4. Confirm the uploaded object still exists in R2 before waking a
  // container for it — a cheap HEAD is far cheaper than a cold start.
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

  // 5. Plan the work from the catalogue: which distinct target dimensions this
  // ratio's master is responsible for.
  const variants = await loadActivePrintVariants(supabase, uploadRow.product_id);
  if (variants.kind === 'invalid') {
    await failJob('failed_action_required', variants.message, attempts);
    return;
  }
  const selection = selectProfilesForRatio(variants.variants, uploadRow.ratio);
  if (selection.kind === 'invalid') {
    await failJob('failed_action_required', selection.message, attempts);
    return;
  }

  // 6. Render each profile through the container, SEQUENTIALLY — the plan's
  // "jedno zadanie naraz, profile przetwarzane kolejno" (one job at a time,
  // profiles processed in order) on a single `standard-3` instance. The DO
  // serialises internally too; this loop keeps the memory profile of the whole
  // pipeline to one derivative at a time.
  const revision = assetRevisionForUpload(uploadId);
  const format = uploadRow.content_type === 'image/png' ? 'png' : 'jpg';
  const processor = env.PRINT_ASSET_PROCESSOR.getByName(PRINT_ASSET_PROCESSOR_NAME);
  const staged: StagedAssetRow[] = [];
  // Finding 2: ONE absolute deadline for the whole loop, computed once before
  // the first profile — NOT a fresh budget per profile. Threaded across the
  // Worker → Durable Object RPC boundary via `RenderInput.deadlineMs` (plain
  // data; the DO cannot share in-process state with this Worker isolate).
  const deadlineMs = Date.now() + JOB_DEADLINE_MS;

  for (const profile of selection.profiles) {
    const remainingMs = deadlineMs - Date.now();

    let result: RenderResult;
    if (remainingMs <= MIN_PROFILE_BUDGET_MS) {
      // Not enough of the job-wide deadline left to realistically start
      // another profile. Fail it exactly like a container-reported timeout
      // WITHOUT spending an RPC on it — the whole point is staying well
      // inside the queue's wall-clock limit instead of getting hard-killed
      // mid-RPC (Finding 2's fix step 3).
      result = {
        kind: 'retryable',
        code: 'CONTAINER_TIMEOUT',
        message: `job ${jobId} exceeded its render deadline before profile ${profile.profileKey} could start (${Math.max(0, remainingMs)}ms remaining)`,
      };
    } else {
      const input: RenderInput = {
        jobId,
        uploadId,
        productId: uploadRow.product_id,
        revision,
        sourceKey: uploadRow.r2_key,
        sourceContentType: uploadRow.content_type,
        expectedRatio: uploadRow.ratio,
        target: { w: profile.w, h: profile.h },
        format,
        deadlineMs,
      };

      try {
        result = await processor.renderDerivative(input);
      } catch (e) {
        // An RPC-level throw (container crash, DO eviction, network fault) is
        // always transient from this consumer's point of view.
        const message = `container RPC failed for profile ${profile.profileKey}: ${String(e)}`;
        await failJob('failed_retryable', message, attempts);
        throw e; // queue retries
      }
    }

    if (result.kind === 'permanent') {
      await failJob('failed_action_required', `profile ${profile.profileKey}: ${result.code} — ${result.message}`, attempts);
      return;
    }
    if (result.kind === 'retryable') {
      const message = `profile ${profile.profileKey}: ${result.code} — ${result.message}`;
      await failJob('failed_retryable', message, attempts);
      throw new Error(message); // queue retries
    }
    staged.push(result.asset);
  }

  // 7. Stage the produced derivatives. `ignoreDuplicates` on the
  // content-addressed r2_key makes a retried job a no-op rather than a
  // conflict — and, critically, never an UPDATE: an asset already promoted
  // past `staged` would be rejected by the migration's
  // guard_print_asset_immutable trigger if this tried to write it back down to
  // 'staged'. The ids are then read back by key (the upsert returns nothing
  // for rows it ignored).
  const { error: stageErr } = await supabase
    .from('print_fulfilment_assets')
    .upsert(staged, { onConflict: 'r2_key', ignoreDuplicates: true });
  if (stageErr) throw stageErr; // transient DB error → queue retry

  const keys = staged.map((row) => row.r2_key);
  const { data: assetRows, error: readBackErr } = await supabase
    .from('print_fulfilment_assets')
    .select('id, r2_key')
    .in('r2_key', keys);
  if (readBackErr) throw readBackErr;

  const byKey = new Map(((assetRows ?? []) as { id: string; r2_key: string }[]).map((row) => [row.r2_key, row.id]));
  const missingKeys = keys.filter((key) => !byKey.has(key));
  if (missingKeys.length > 0) {
    // The rows were just written; their absence means the write silently did
    // not land. Retry rather than finalize a job with no assets behind it.
    const message = `staged asset rows missing after upsert: ${missingKeys.join(', ')}`;
    await failJob('failed_retryable', message, attempts);
    throw new Error(message);
  }

  // 7b. Promote every just-staged row to ready (Priority 8 / Phase 4) — see
  // promote.ts's header comment for why this is safe to do unconditionally
  // here, unlike the CLI's separate verify step. A promotion failure is
  // always a transient DB fault or a genuine concurrent-revoke race; treat it
  // the same as any other DB error in this function: retryable.
  await promoteStagedAssets(supabase, { productId: uploadRow.product_id, revision, r2Keys: keys });

  // 8. Finalize. `asset_id` points at the FIRST profile's asset — the column is
  // a single uuid but a job legitimately produces one row per profile, so it
  // names the job's primary output deterministically (profiles are sorted by
  // profileKey in distinctProfiles). Every row of the set is discoverable via
  // (product_id, revision). Same finalize-CAS-may-lose-the-race tolerance as
  // fulfilment/process-job.ts: a concurrent delivery of the same message could
  // have finalized this job first, so 0 rows updated is logged, not thrown.
  // Finding 1: `lease_token` is now PART of that CAS — a worker whose lease
  // expired and was reclaimed mid-render loses this race even if `status` is
  // still (coincidentally) `processing`, because the token, not just the
  // status, proves ownership.
  const primaryAssetId = byKey.get(keys[0]) ?? null;
  const { data: finalized, error: doneErr } = await supabase
    .from('print_asset_jobs')
    .update({ status: 'completed', asset_id: primaryAssetId, attempts, updated_at: now() })
    .eq('id', jobId)
    .eq('lease_token', leaseToken)
    .in('status', ['processing'])
    .select('id')
    .maybeSingle();
  if (doneErr) throw doneErr;
  if (!finalized) {
    console.warn(`processAssetJob: job ${jobId} finalized by a concurrent delivery — leaving its status untouched`);
  }
}
