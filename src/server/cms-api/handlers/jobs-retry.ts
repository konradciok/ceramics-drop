import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { getJobRowById, requeueJobRow, mapJobRowToResponse } from '../jobs-mapping';
import { sendAssetJobMessage } from '@/server/asset-jobs/enqueue';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// print_asset_jobs.id is a uuid column — same malformed-id-before-any-other-work
// discipline as uploads-confirm.ts's UUID_RE guard.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETRYABLE_STATUSES = new Set(['failed_retryable', 'failed_action_required']);

// POST /v1/jobs/{id}/retry: re-enqueues a failed job. Mirrors
// src/server/fulfilment/process-job.ts's own retry semantics — its claim
// predicate (`.in('status', ['queued', 'failed_retryable', ...])`) already
// treats a failed_retryable row flipped back to 'queued' as claimable by the
// SAME queue message — so this endpoint re-uses the SAME job row (CAS status
// -> 'queued') and the SAME job id, rather than minting a new
// print_asset_jobs row, then re-sends the ASSET_JOBS_QUEUE message with that
// id. This is a manually-triggered instance of the same retry the queue's own
// backoff performs automatically.
export const jobsRetryRoute: RouteDef = {
  method: 'POST',
  path: '/v1/jobs/{id}/retry',
  handler: async (req, env, params, ctx) => {
    if (!UUID_RE.test(params.id)) {
      return errorResponse('NOT_FOUND', `Job ${params.id} does not exist.`, 404, ctx.requestId);
    }

    const idempotencyKey = req.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      return errorResponse('IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is required.', 422, ctx.requestId);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }
    if (typeof body !== 'object' || body === null) {
      return errorResponse('VALIDATION_FAILED', 'Request body must be a JSON object.', 422, ctx.requestId);
    }
    // Revision schema is bare {expectedRevision} — same convention as every
    // other publication/confirm-shaped handler (uploads-confirm.ts et al.).
    const parsed = body as { expectedRevision?: unknown };
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }
    const expectedRevision = parsed.expectedRevision as number;

    const claim = await claimIdempotencyKey(ctx.supabase, 'jobs:retry', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    const release = async () => {
      try {
        await releaseIdempotencyKey(ctx.supabase, 'jobs:retry', idempotencyKey, leaseToken);
      } catch {
        // ignore — see uploads-confirm.ts's identical rationale.
      }
    };

    try {
      const current = await getJobRowById(ctx.supabase, params.id);
      if (!current) {
        await release();
        return errorResponse('NOT_FOUND', `Job ${params.id} does not exist.`, 404, ctx.requestId);
      }
      if (current.asset_revision !== expectedRevision) {
        await release();
        return errorResponse(
          'REVISION_CONFLICT',
          'To zadanie zmieniło stan od czasu ostatniego odczytu.',
          409,
          ctx.requestId,
          { currentRevision: current.asset_revision },
        );
      }
      if (!RETRYABLE_STATUSES.has(current.status)) {
        await release();
        return errorResponse(
          'VALIDATION_FAILED',
          `Job ${params.id} is not in a retryable state (status=${current.status}).`,
          422,
          ctx.requestId,
        );
      }

      const requeued = await requeueJobRow(ctx.supabase, params.id);
      if (!requeued) {
        // Lost a race against a concurrent retry/finalization between the read
        // above and this CAS write — same REVISION_CONFLICT response as
        // uploads-confirm.ts's identical race, just without a fresh
        // currentRevision (asset_revision is immutable per job, so re-reading
        // it would not tell the client anything new).
        await release();
        return errorResponse('REVISION_CONFLICT', 'To zadanie zostało już ponowione przez inne żądanie.', 409, ctx.requestId);
      }

      try {
        await sendAssetJobMessage(env, { jobId: requeued.id, uploadId: requeued.upload_id });
      } catch (sendErr) {
        // The CAS write above already moved the row to `queued`. If the queue
        // send itself fails, leaving it `queued` with no message in flight
        // would strand it forever — the retry endpoint below only accepts
        // failed_retryable/failed_action_required, so a second retry attempt
        // would be rejected with 422. Restore the pre-requeue status so the
        // row is retryable again, then propagate the original error (still
        // caught by the outer catch, which releases the idempotency lease).
        const { error: resetError } = await ctx.supabase
          .from('print_asset_jobs')
          .update({
            status: 'failed_retryable',
            last_error: sendErr instanceof Error ? sendErr.message : String(sendErr),
            updated_at: new Date().toISOString(),
          })
          .eq('id', requeued.id)
          .eq('status', 'queued');
        if (resetError) throw resetError;
        throw sendErr;
      }

      const job = mapJobRowToResponse(requeued);
      await completeIdempotencyKey(ctx.supabase, 'jobs:retry', idempotencyKey, leaseToken, 202, job);
      return jsonResponse(job, 202);
    } catch (err) {
      await release();
      throw err;
    }
  },
};
