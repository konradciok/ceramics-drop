import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadProductResponse } from '../mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

function generateProductId(): string {
  return `prd_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export const productsDuplicateRoute: RouteDef = {
  method: 'POST',
  path: '/v1/products/{id}/duplicate',
  handler: async (req, env, params, ctx) => {
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
    const parsed = body as { expectedRevision?: unknown };
    if (typeof parsed.expectedRevision !== 'number') {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }

    const claim = await claimIdempotencyKey(ctx.supabase, 'products:duplicate', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    try {
      const source = await loadProductResponse(ctx.supabase, env, params.id);
      if (!source) {
        await releaseIdempotencyKey(ctx.supabase, 'products:duplicate', idempotencyKey, leaseToken);
        return errorResponse('NOT_FOUND', `Product ${params.id} does not exist.`, 404, ctx.requestId);
      }
      if (source.revision !== parsed.expectedRevision) {
        await releaseIdempotencyKey(ctx.supabase, 'products:duplicate', idempotencyKey, leaseToken);
        return errorResponse(
          'REVISION_CONFLICT',
          'Ktoś zapisał nowszą wersję. Przejrzyj zmiany i spróbuj ponownie.',
          409,
          ctx.requestId,
          { currentRevision: source.revision },
        );
      }

      const categorySlug = source.draft.type === 'ceramic' ? source.draft.category : 'fine-art-prints';
      let newId = generateProductId();
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error } = await ctx.supabase.rpc('create_product_with_draft', {
          p_id: newId,
          p_type: source.type,
          p_category_slug: categorySlug,
          p_num: source.draft.displayNumber,
          p_payload: source.draft,
          p_actor_email: ctx.actorEmail,
        });
        if (!error) break;
        if (error.code === '23505' && attempt < 2) {
          newId = generateProductId();
          continue;
        }
        throw error;
      }

      const duplicate = await loadProductResponse(ctx.supabase, env, newId);
      await completeIdempotencyKey(ctx.supabase, 'products:duplicate', idempotencyKey, leaseToken, 200, duplicate);
      return jsonResponse(duplicate, 200);
    } catch (err) {
      await releaseIdempotencyKey(ctx.supabase, 'products:duplicate', idempotencyKey, leaseToken);
      throw err;
    }
  },
};
