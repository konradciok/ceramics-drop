import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { PRICING_RESOURCE_ID, loadPricingResource } from '../pricing-mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const pricingRestorePostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/pricing/{id}/restore',
  handler: async (req, _env, params, ctx) => {
    if (params.id !== PRICING_RESOURCE_ID) {
      return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
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
    // Restore schema is {expectedRevision, sourceRevision} (contracts/cms-v1.json).
    const parsed = body as { expectedRevision?: unknown; sourceRevision?: unknown };
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }
    if (!Number.isInteger(parsed.sourceRevision)) {
      return errorResponse('VALIDATION_FAILED', 'sourceRevision is required.', 422, ctx.requestId, {
        fieldErrors: { sourceRevision: 'required' },
      });
    }

    const claim = await claimIdempotencyKey(ctx.supabase, 'pricing:restore', idempotencyKey, { id: params.id, ...parsed });
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
        await releaseIdempotencyKey(ctx.supabase, 'pricing:restore', idempotencyKey, leaseToken);
      } catch {
        // ignore — a failed release just leaves the lease for idempotency.ts's
        // 30s LEASE_MS to reclaim (same rationale as collections-restore.ts).
      }
    };

    try {
      // restore_pricing_draft copies pricing_config_drafts' p_source_revision
      // payload into a brand-new revision (current max + 1) and NEVER touches
      // print_pricing_config — restoring an old price list does not publish it,
      // so checkout keeps reading the currently-published values until an
      // explicit publish (Global Constraint 19).
      const { error } = await ctx.supabase.rpc('restore_pricing_draft', {
        p_expected_revision: parsed.expectedRevision,
        p_source_revision: parsed.sourceRevision,
        p_actor_email: ctx.actorEmail,
      });

      if (error) {
        await release();
        if (error.message?.includes('pricing_config_missing')) {
          return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
        }
        if (error.message?.includes('revision_conflict')) {
          return errorResponse(
            'REVISION_CONFLICT',
            'Ktoś zapisał nowszą wersję. Przejrzyj zmiany i spróbuj ponownie.',
            409,
            ctx.requestId,
            { currentRevision: extractCurrentRevision(error) },
          );
        }
        if (error.message?.includes('source_revision_not_found')) {
          return errorResponse(
            'NOT_FOUND',
            `Revision ${String(parsed.sourceRevision)} does not exist for pricing ${params.id}.`,
            404,
            ctx.requestId,
          );
        }
        throw error;
      }

      const resource = await loadPricingResource(ctx.supabase);
      await completeIdempotencyKey(ctx.supabase, 'pricing:restore', idempotencyKey, leaseToken, 200, resource);
      return jsonResponse(resource);
    } catch (err) {
      await release();
      throw err;
    }
  },
};
