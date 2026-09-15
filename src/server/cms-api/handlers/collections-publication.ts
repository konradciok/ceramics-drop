import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadCollectionResponse } from '../collections-mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// Same currentRevision=<n> detail-string parsing as products-save.ts's /
// publication.ts's / collections-save.ts's extractCurrentRevision (Global
// Constraint 8/21) — publish_collection_revision raises 'revision_conflict'
// with the same detail format.
function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

// product_ref_invalid's detail-string format (invalidIds=<comma-joined ids>)
// is pinned by Global Constraint 11 — publish_collection_revision (Task 1's
// migration, 20260915120000_cms_api_collections.sql) raises it via
// `raise exception 'product_ref_invalid' using detail =
// format('invalidIds=%s', array_to_string(v_invalid_ids, ','));`. Parsed
// verbatim per that constraint: /invalidIds=(.*)$/ against
// error.message + error.details, split the captured group on ','.
function extractInvalidProductIds(error: { details?: string | null; message?: string }): string[] {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/invalidIds=(.*)$/);
  if (!match) return [];
  return match[1].split(',').filter((id) => id.length > 0);
}

export const collectionsPublicationPostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/collections/{id}/publication',
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
    // Contract's Revision schema is bare {expectedRevision} — no `action`
    // field (Global Constraint 9/17/20: collections have no status states).
    const parsed = body as { expectedRevision?: unknown };
    // Number.isInteger rejects non-numbers, NaN, Infinity, and fractional
    // values in one check — a fractional or non-finite revision would
    // otherwise pass the old `typeof === 'number'` check and reach the RPC.
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }

    const claim = await claimIdempotencyKey(ctx.supabase, 'collections:publication', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    try {
      const { error } = await ctx.supabase.rpc('publish_collection_revision', {
        p_collection_id: params.id,
        p_expected_revision: parsed.expectedRevision,
        p_actor_email: ctx.actorEmail,
      });

      if (error) {
        // Swallow a release failure so it can't replace the mapped RPC error
        // response below with a generic 500 — a failed release just leaves
        // the lease in place, and the 30s LEASE_MS in idempotency.ts lets a
        // later request reclaim it, so this is a safe no-op.
        try {
          await releaseIdempotencyKey(ctx.supabase, 'collections:publication', idempotencyKey, leaseToken);
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
        if (error.message?.includes('draft_required')) {
          return errorResponse('VALIDATION_FAILED', 'Zapisz wersję roboczą przed publikacją.', 422, ctx.requestId);
        }
        if (error.message?.includes('missing_polish')) {
          return errorResponse('MISSING_POLISH', 'Uzupełnij pole w języku polskim przed publikacją.', 422, ctx.requestId);
        }
        if (error.message?.includes('product_ref_invalid')) {
          return errorResponse(
            'VALIDATION_FAILED',
            'Kolekcja zawiera nieistniejące produkty.',
            422,
            ctx.requestId,
            // Contract's Error.fieldErrors is Record<string, string> (every
            // value must be a string) — join the parsed ids the same way
            // publication.ts's readiness.blockers is joined into
            // fieldErrors.variants ('; ' separator).
            { fieldErrors: { products: extractInvalidProductIds(error).join('; ') } },
          );
        }
        throw error;
      }

      const collection = await loadCollectionResponse(ctx.supabase, params.id);
      await completeIdempotencyKey(ctx.supabase, 'collections:publication', idempotencyKey, leaseToken, 200, collection);
      return jsonResponse(collection);
    } catch (err) {
      // Swallow a release failure here so the original publication error
      // (err) always propagates — a failed release just leaves the lease in
      // place, and the 30s LEASE_MS in idempotency.ts lets a later request
      // reclaim it, so this is a safe no-op rather than a stuck key (same
      // rationale as publication.ts's publicationPostRoute).
      try {
        await releaseIdempotencyKey(ctx.supabase, 'collections:publication', idempotencyKey, leaseToken);
      } catch {
        // ignore — see comment above
      }
      throw err;
    }
  },
};
