import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { getJobRowById } from '../jobs-mapping';
import { getUploadRowById } from '../uploads-mapping';
import { loadActivePrintVariants, assetRevisionForUpload } from '@/server/asset-jobs/profiles';
import { buildJobPublishAssignments } from '@/server/asset-jobs/publish-assignments';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// print_asset_jobs.id is a uuid column — same guard as jobs-retry.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /v1/jobs/{id}/publish — Priority 8 / Phase 4. Assigns a completed
 * job's ready print_fulfilment_assets to every active variant of its product,
 * via the existing publish_print_asset_revision RPC — the same "go live"
 * action the CLI's print-assets:publish performs, exposed through CmsApi for
 * the CMS-driven pipeline.
 *
 * Scope note (see publish-assignments.ts and this plan's Global Constraints):
 * a job's revision only covers the ONE ratio its upload was for. A product
 * whose active variants span more than one ratio will always be missing some
 * variants here — reported as 422 MISSING_PROFILES, not silently partial.
 */
export const jobsPublishRoute: RouteDef = {
  method: 'POST',
  path: '/v1/jobs/{id}/publish',
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
    const parsed = body as { expectedRevision?: unknown };
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }

    const claim = await claimIdempotencyKey(ctx.supabase, 'jobs:publish', idempotencyKey, { id: params.id, ...parsed });
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
        await releaseIdempotencyKey(ctx.supabase, 'jobs:publish', idempotencyKey, leaseToken);
      } catch {
        // ignore — see uploads-confirm.ts's identical rationale.
      }
    };

    // The entire post-claim body lives inside this one try/catch —
    // getJobRowById, getUploadRowById and loadActivePrintVariants each do
    // `if (error) throw error` internally on a transient Supabase error, and
    // an uncaught throw from any of them would propagate straight past every
    // `release()` call below, past this handler entirely, to
    // request-handler.ts's outer catch (500, no idempotency-table write). The
    // lease would then sit stuck 'processing' for the full 30s LEASE_MS
    // window, and a client retry with the same Idempotency-Key would get a
    // misleading 409 IDEMPOTENCY_IN_PROGRESS instead of a clean retry. Same
    // shape as jobs-retry.ts's outer try/catch and uploads-create.ts's
    // identical fix for this exact failure mode on loadActivePrintVariants
    // (see uploads-create.ts's comment). The explicit
    // `await release(); return errorResponse(...)` branches below are
    // unaffected — they return before the catch could ever see them.
    try {
      const job = await getJobRowById(ctx.supabase, params.id);
      if (!job) {
        await release();
        return errorResponse('NOT_FOUND', `Job ${params.id} does not exist.`, 404, ctx.requestId);
      }
      // Same CAS convention as jobs-retry.ts: Job.revision (the contract field)
      // is row.asset_revision — the upload's revision snapshot, NOT row.attempts.
      if (job.asset_revision !== parsed.expectedRevision) {
        await release();
        return errorResponse(
          'REVISION_CONFLICT',
          'To zadanie zmieniło stan od czasu ostatniego odczytu.',
          409,
          ctx.requestId,
          { currentRevision: job.asset_revision },
        );
      }
      if (job.status !== 'completed') {
        await release();
        return errorResponse('VALIDATION_FAILED', `Job ${params.id} is not completed (status="${job.status}").`, 422, ctx.requestId);
      }

      const upload = await getUploadRowById(ctx.supabase, job.upload_id);
      if (!upload) {
        await release();
        return errorResponse('NOT_FOUND', `Upload ${job.upload_id} for this job no longer exists.`, 404, ctx.requestId);
      }

      const variantsResult = await loadActivePrintVariants(ctx.supabase, upload.product_id);
      if (variantsResult.kind === 'invalid') {
        await release();
        return errorResponse('VALIDATION_FAILED', variantsResult.message, 422, ctx.requestId);
      }

      // print_fulfilment_assets.profile_key is a real, directly queryable
      // column (e.g. "3600x4800") — no need to reconstruct the content-
      // addressed r2_key, which would require a sha256 this handler never
      // independently computes. See publish-assignments.ts's header comment.
      const revision = assetRevisionForUpload(job.upload_id);
      const { data: readyRows, error: readyErr } = await ctx.supabase
        .from('print_fulfilment_assets')
        .select('id, profile_key')
        .eq('product_id', upload.product_id)
        .eq('revision', revision)
        .eq('status', 'ready');
      if (readyErr) {
        await release();
        return errorResponse('INTERNAL_ERROR', 'Failed to read ready assets.', 500, ctx.requestId);
      }
      const readyAssetIdByProfileKey = new Map(
        ((readyRows ?? []) as { id: string; profile_key: string | null }[])
          .filter((r): r is { id: string; profile_key: string } => r.profile_key !== null)
          .map((r) => [r.profile_key, r.id]),
      );

      const assignmentResult = buildJobPublishAssignments(variantsResult.variants, readyAssetIdByProfileKey);
      if (assignmentResult.kind === 'missing_profiles') {
        await release();
        return errorResponse(
          'MISSING_PROFILES',
          `Not every active variant has a ready asset under revision "${revision}" — missing: ${assignmentResult.missingVariantKeys.join(', ')}. ` +
            "This product may span more than one print ratio; see this plan's Global Constraints.",
          422,
          ctx.requestId,
        );
      }

      try {
        const { data, error } = await ctx.supabase.rpc('publish_print_asset_revision', {
          p_product_id: upload.product_id,
          p_revision: revision,
          p_assignments: assignmentResult.assignments,
          // Every other publish/save/restore RPC call in this codebase
          // (products-save.ts, collections-publication.ts, pricing-publication.ts,
          // etc.) passes p_actor_email: ctx.actorEmail so catalog_audit_log
          // records who acted — the CLI's own call to this exact RPC
          // (scripts/print-assets-publish.ts) does the same. Omitting it here
          // would silently leave every CMS-triggered publish's audit row
          // attributed to nobody (actor_email = null).
          p_actor_email: ctx.actorEmail,
        });
        if (error) throw error;
        const row = (data as { product_id: string; revision: string; assigned_count: number }[] | null)?.[0];
        const result = { productId: upload.product_id, revision, assignedCount: row?.assigned_count ?? 0 };
        // Argument order matches jobs-retry.ts's completeIdempotencyKey call:
        // (supabase, scope, idempotencyKey, leaseToken, status, body) — status
        // BEFORE body.
        await completeIdempotencyKey(ctx.supabase, 'jobs:publish', idempotencyKey, leaseToken, 200, result);
        return jsonResponse(result, 200);
      } catch (e) {
        await release();
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('assignment_mismatch')) {
          return errorResponse('MISSING_PROFILES', `Publish assignment does not exactly match active variants: ${message}`, 422, ctx.requestId);
        }
        return errorResponse('INTERNAL_ERROR', `Publish failed: ${message}`, 500, ctx.requestId);
      }
    } catch (err) {
      await release();
      throw err;
    }
  },
};
