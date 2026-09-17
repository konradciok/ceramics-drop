import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { isShippingRateId, loadShippingRateResource } from '../shipping-rates-mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const shippingRatesRestorePostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/shipping-rates/{id}/restore',
  handler: async (req, _env, params, ctx) => {
    if (!isShippingRateId(params.id)) {
      return errorResponse('NOT_FOUND', `Shipping rates ${params.id} do not exist.`, 404, ctx.requestId);
    }
    const rateId = params.id;

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

    const claim = await claimIdempotencyKey(ctx.supabase, 'shipping-rates:restore', idempotencyKey, { id: rateId, ...parsed });
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
        await releaseIdempotencyKey(ctx.supabase, 'shipping-rates:restore', idempotencyKey, leaseToken);
      } catch {
        // ignore — a failed release just leaves the lease for idempotency.ts's
        // 30s LEASE_MS to reclaim (same rationale as pricing-restore.ts).
      }
    };

    try {
      // restore_shipping_rate_draft copies the source revision's payload into a
      // brand-new revision (current max + 1) and NEVER touches
      // shipping_rates.published_revision — restoring an old price list does
      // not publish it, so checkout keeps charging the currently-published
      // revision until an explicit publish (Global Constraint 19).
      const { error } = await ctx.supabase.rpc('restore_shipping_rate_draft', {
        p_rate_id: rateId,
        p_expected_revision: parsed.expectedRevision,
        p_source_revision: parsed.sourceRevision,
        p_actor_email: ctx.actorEmail,
      });

      if (error) {
        await release();
        if (error.message?.includes('shipping_rate_not_found')) {
          return errorResponse('NOT_FOUND', `Shipping rates ${rateId} do not exist.`, 404, ctx.requestId);
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
            `Revision ${String(parsed.sourceRevision)} does not exist for shipping rates ${rateId}.`,
            404,
            ctx.requestId,
          );
        }
        throw error;
      }

      const resource = await loadShippingRateResource(ctx.supabase, rateId);
      await completeIdempotencyKey(ctx.supabase, 'shipping-rates:restore', idempotencyKey, leaseToken, 200, resource);
      return jsonResponse(resource);
    } catch (err) {
      await release();
      throw err;
    }
  },
};
