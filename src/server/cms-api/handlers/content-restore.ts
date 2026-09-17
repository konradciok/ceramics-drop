import type { RouteDef, HandlerContext } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { decodeContentResourceId, loadContentResource } from '../content-mapping';
import { revertVersion } from '@/lib/admin/content';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

export const contentRestorePostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/content/{id}/restore',
  handler: async (req, _env, params, ctx) => {
    const parts = decodeContentResourceId(params.id);
    if (!parts) {
      return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
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
    const expectedRevision = parsed.expectedRevision as number;
    const sourceRevision = parsed.sourceRevision as number;

    const claim = await claimIdempotencyKey(ctx.supabase, 'content:restore', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    try {
      // Same read-then-write expectedRevision guard as content-save.ts /
      // content-publication.ts — content.ts's revertVersion (a re-save of
      // an old version's payload as a brand-new draft; it never touches
      // publish state, matching restore_collection_draft's semantics — see
      // Global Constraint 19) has no built-in optimistic-concurrency check.
      const current = await loadContentResource(parts.kind, parts.slug, parts.locale);
      if (!current) {
        await releaseSafely(ctx, idempotencyKey, leaseToken);
        return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
      }
      if (current.revision !== expectedRevision) {
        await releaseSafely(ctx, idempotencyKey, leaseToken);
        return errorResponse(
          'REVISION_CONFLICT',
          'Ktoś zapisał nowszą wersję. Przejrzyj zmiany i spróbuj ponownie.',
          409,
          ctx.requestId,
          { currentRevision: current.revision },
        );
      }

      try {
        await revertVersion({ kind: parts.kind, slug: parts.slug, locale: parts.locale, version: sourceRevision, actorEmail: ctx.actorEmail });
      } catch (err) {
        await releaseSafely(ctx, idempotencyKey, leaseToken);
        if (err instanceof Error && (err.message === 'unsupported_document' || err.message === 'document_not_found')) {
          return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
        }
        if (err instanceof Error && err.message === 'version_not_found') {
          return errorResponse('NOT_FOUND', `Revision ${sourceRevision} does not exist for content ${params.id}.`, 404, ctx.requestId);
        }
        throw err;
      }

      const resource = await loadContentResource(parts.kind, parts.slug, parts.locale);
      await completeIdempotencyKey(ctx.supabase, 'content:restore', idempotencyKey, leaseToken, 200, resource);
      return jsonResponse(resource);
    } catch (err) {
      try {
        await releaseIdempotencyKey(ctx.supabase, 'content:restore', idempotencyKey, leaseToken);
      } catch {
        // ignore — see releaseSafely's comment
      }
      throw err;
    }
  },
};

async function releaseSafely(ctx: HandlerContext, idempotencyKey: string, leaseToken: string): Promise<void> {
  try {
    await releaseIdempotencyKey(ctx.supabase, 'content:restore', idempotencyKey, leaseToken);
  } catch {
    // ignore — a failed release just leaves the lease in place; the 30s
    // LEASE_MS in idempotency.ts lets a later request reclaim it.
  }
}
