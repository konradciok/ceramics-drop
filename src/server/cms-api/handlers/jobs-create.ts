import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { getUploadRowById } from '../uploads-mapping';
import { mapJobRowToResponse } from '../jobs-mapping';
import { enqueueAssetJob } from '@/server/asset-jobs/enqueue';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// POST /v1/jobs: turns a CONFIRMED print_asset_uploads row (Task 9, Phase 1)
// into a print_asset_jobs row + an ASSET_JOBS_QUEUE message — the entry point
// into Phase 2's durable job queue (src/server/asset-jobs/enqueue.ts). The
// contract's JobCreate body is {assetId, expectedRevision} — assetId mirrors
// print_asset_uploads.id (see uploads-mapping.ts's mapUploadRowToIntent
// comment: "nothing downstream of confirm yet materializes a distinct asset
// identity"), and expectedRevision CAS-guards against the upload's OWN
// revision (1 once confirmed) — the same optimistic-concurrency idiom every
// other mutating S1-S4 endpoint uses.
export const jobsCreateRoute: RouteDef = {
  method: 'POST',
  path: '/v1/jobs',
  handler: async (req, env, _params, ctx) => {
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

    const parsed = body as { assetId?: unknown; expectedRevision?: unknown };
    const fieldErrors: Record<string, string> = {};
    if (typeof parsed.assetId !== 'string' || parsed.assetId.length === 0) fieldErrors.assetId = 'required';
    if (!Number.isInteger(parsed.expectedRevision)) fieldErrors.expectedRevision = 'required';
    if (Object.keys(fieldErrors).length > 0) {
      return errorResponse('VALIDATION_FAILED', 'assetId and expectedRevision are required.', 422, ctx.requestId, { fieldErrors });
    }
    const assetId = parsed.assetId as string;
    const expectedRevision = parsed.expectedRevision as number;

    const claim = await claimIdempotencyKey(ctx.supabase, 'jobs:create', idempotencyKey, body);
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
        await releaseIdempotencyKey(ctx.supabase, 'jobs:create', idempotencyKey, leaseToken);
      } catch {
        // ignore — a failed release just leaves the lease in place; the 30s
        // LEASE_MS in idempotency.ts lets a later request reclaim it (same
        // rationale as uploads-confirm.ts's identical release()).
      }
    };

    try {
      const upload = await getUploadRowById(ctx.supabase, assetId);
      if (!upload) {
        await release();
        return errorResponse('NOT_FOUND', `Asset ${assetId} does not exist.`, 404, ctx.requestId);
      }
      if (upload.status !== 'confirmed') {
        await release();
        return errorResponse('VALIDATION_FAILED', 'Ten upload nie został jeszcze potwierdzony.', 422, ctx.requestId, {
          fieldErrors: { assetId: 'not confirmed' },
        });
      }
      if (upload.revision !== expectedRevision) {
        await release();
        return errorResponse(
          'REVISION_CONFLICT',
          'Ten upload zmienił stan od czasu ostatniego odczytu.',
          409,
          ctx.requestId,
          { currentRevision: upload.revision },
        );
      }

      const jobRow = await enqueueAssetJob(ctx.supabase, env, { uploadId: assetId, assetRevision: expectedRevision });
      const job = mapJobRowToResponse(jobRow);
      await completeIdempotencyKey(ctx.supabase, 'jobs:create', idempotencyKey, leaseToken, 202, job);
      return jsonResponse(job, 202);
    } catch (err) {
      await release();
      throw err;
    }
  },
};
