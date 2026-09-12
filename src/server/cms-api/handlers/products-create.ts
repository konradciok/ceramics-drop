import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateProductDraft } from '../validation';
import { loadProductResponse } from '../mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

function generateProductId(): string {
  return `prd_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export const productsCreateRoute: RouteDef = {
  method: 'POST',
  path: '/v1/products',
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

    const claim = await claimIdempotencyKey(ctx.supabase, 'products:create', idempotencyKey, body);
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    const validated = validateProductDraft(body);
    if (!validated.ok) {
      await releaseIdempotencyKey(ctx.supabase, 'products:create', idempotencyKey, leaseToken);
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }

    const draft = validated.data;
    const categorySlug = draft.type === 'ceramic' ? draft.category : 'fine-art-prints';

    try {
      let productId = generateProductId();
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error } = await ctx.supabase.rpc('create_product_with_draft', {
          p_id: productId,
          p_type: draft.type,
          p_category_slug: categorySlug,
          p_num: draft.displayNumber,
          p_payload: draft,
          p_actor_email: ctx.actorEmail,
        });
        if (!error) break;
        if (error.code === '23505' && attempt < 2) {
          productId = generateProductId();
          continue;
        }
        throw error;
      }

      const product = await loadProductResponse(ctx.supabase, env, productId);
      await completeIdempotencyKey(ctx.supabase, 'products:create', idempotencyKey, leaseToken, 200, product);
      return jsonResponse(product, 200);
    } catch (err) {
      await releaseIdempotencyKey(ctx.supabase, 'products:create', idempotencyKey, leaseToken);
      throw err;
    }
  },
};
