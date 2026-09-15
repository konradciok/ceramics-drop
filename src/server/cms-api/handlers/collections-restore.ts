import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadCollectionResponse } from '../collections-mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// Same currentRevision=<n> detail-string parsing as products-save.ts's /
// publication.ts's / collections-save.ts's / collections-publication.ts's
// extractCurrentRevision (Global Constraint 8/21) — restore_collection_draft
// raises 'revision_conflict' with that same detail format.
function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const collectionsRestorePostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/collections/{id}/restore',
  handler: async (req, _env, params, ctx) => {
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
    // Restore schema is {expectedRevision, sourceRevision} (contracts/cms-v1.json,
    // both required integers, additionalProperties:false at the contract
    // level — the handler only needs to check the two fields it forwards to
    // the RPC, same inline-validation style as collections-publication.ts's
    // bare {expectedRevision} Revision schema).
    const parsed = body as { expectedRevision?: unknown; sourceRevision?: unknown };
    // Number.isInteger rejects non-numbers, NaN, Infinity, and fractional
    // values in one check — a fractional or non-finite revision would
    // otherwise pass the old `typeof === 'number'` check and reach the RPC.
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

    const claim = await claimIdempotencyKey(ctx.supabase, 'collections:restore', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    try {
      // restore_collection_draft (Task 1's migration) copies collection_drafts'
      // p_source_revision payload into a brand-new revision (current max + 1)
      // and never touches collections.published_revision — restoring an old
      // draft does not publish it (Global Constraint 19).
      const { error } = await ctx.supabase.rpc('restore_collection_draft', {
        p_collection_id: params.id,
        p_expected_revision: parsed.expectedRevision,
        p_source_revision: parsed.sourceRevision,
        p_actor_email: ctx.actorEmail,
      });

      if (error) {
        // Swallow a release failure so it can't replace the mapped RPC error
        // response below with a generic 500 — a failed release just leaves
        // the lease in place, and the 30s LEASE_MS in idempotency.ts lets a
        // later request reclaim it, so this is a safe no-op.
        try {
          await releaseIdempotencyKey(ctx.supabase, 'collections:restore', idempotencyKey, leaseToken);
        } catch {
          // ignore — see comment above
        }
        if (error.message?.includes('collection_not_found')) {
          return errorResponse('NOT_FOUND', `Collection ${params.id} does not exist.`, 404, ctx.requestId);
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
            `Revision ${String(parsed.sourceRevision)} does not exist for collection ${params.id}.`,
            404,
            ctx.requestId,
          );
        }
        throw error;
      }

      const collection = await loadCollectionResponse(ctx.supabase, params.id);
      await completeIdempotencyKey(ctx.supabase, 'collections:restore', idempotencyKey, leaseToken, 200, collection);
      return jsonResponse(collection);
    } catch (err) {
      // Swallow a release failure here so the original restore error (err)
      // always propagates — a failed release just leaves the lease in place,
      // and the 30s LEASE_MS in idempotency.ts lets a later request reclaim
      // it, so this is a safe no-op rather than a stuck key (same rationale
      // as collections-publication.ts's collectionsPublicationPostRoute).
      try {
        await releaseIdempotencyKey(ctx.supabase, 'collections:restore', idempotencyKey, leaseToken);
      } catch {
        // ignore — see comment above
      }
      throw err;
    }
  },
};
