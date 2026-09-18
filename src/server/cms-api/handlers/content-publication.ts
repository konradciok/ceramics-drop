import type { RouteDef, HandlerContext } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { decodeContentResourceId, loadContentResource } from '../content-mapping';
import { publishVersion } from '@/lib/admin/content';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

export const contentPublicationPostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/content/{id}/publication',
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
    // Revision schema is bare {expectedRevision} — content has no separate
    // "action" (publish/hide/archive) the way products do; the generic
    // Resource model treats publish as the only action (same posture as
    // collections-publication.ts, Global Constraint 9/17/20).
    const parsed = body as { expectedRevision?: unknown };
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }
    const expectedRevision = parsed.expectedRevision as number;

    const claim = await claimIdempotencyKey(ctx.supabase, 'content:publication', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    try {
      // content.ts's publishVersion publishes ANY existing version by
      // number — it has no built-in "must equal the current latest
      // version" guard the way collections'/products' RPCs do. This
      // handler enforces that guard itself, same rationale as
      // content-save.ts: read the current (locale-scoped) revision first,
      // require expectedRevision to match it, THEN publish exactly that
      // version — a read-then-write check, not an atomic DB-level CAS.
      const current = await loadContentResource(parts.kind, parts.slug, parts.locale, ctx.supabase);
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
        await publishVersion({ kind: parts.kind, slug: parts.slug, locale: parts.locale, version: expectedRevision, actorEmail: ctx.actorEmail, client: ctx.supabase });
      } catch (err) {
        await releaseSafely(ctx, idempotencyKey, leaseToken);
        if (err instanceof Error && (err.message === 'unsupported_document' || err.message === 'document_not_found' || err.message === 'version_not_found')) {
          return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
        }
        throw err;
      }

      const resource = await loadContentResource(parts.kind, parts.slug, parts.locale, ctx.supabase);
      await completeIdempotencyKey(ctx.supabase, 'content:publication', idempotencyKey, leaseToken, 200, resource);
      return jsonResponse(resource);
    } catch (err) {
      // Swallow a release failure so the original error always propagates —
      // same rationale as collections-publication.ts's catch-block release.
      try {
        await releaseIdempotencyKey(ctx.supabase, 'content:publication', idempotencyKey, leaseToken);
      } catch {
        // ignore — see comment above
      }
      throw err;
    }
  },
};

async function releaseSafely(ctx: HandlerContext, idempotencyKey: string, leaseToken: string): Promise<void> {
  try {
    await releaseIdempotencyKey(ctx.supabase, 'content:publication', idempotencyKey, leaseToken);
  } catch {
    // ignore — a failed release just leaves the lease in place; the 30s
    // LEASE_MS in idempotency.ts lets a later request reclaim it.
  }
}
