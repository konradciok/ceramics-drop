import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadProductResponse } from '../mapping';
import { computeReadiness, buildPrintVariantSpecs } from '../readiness';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const publicationGetRoute: RouteDef = {
  method: 'GET',
  path: '/v1/products/{id}/publication',
  handler: async (_req, env, params, ctx) => {
    const product = await loadProductResponse(ctx.supabase, env, params.id);
    if (!product) return errorResponse('NOT_FOUND', `Product ${params.id} does not exist.`, 404, ctx.requestId);
    const readiness = await computeReadiness(ctx.supabase, product);
    return jsonResponse(readiness);
  },
};

const ACTIONS = ['publish', 'hide', 'archive'] as const;

export const publicationPostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/products/{id}/publication',
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
    const parsed = body as { expectedRevision?: unknown; action?: unknown };
    if (typeof parsed.expectedRevision !== 'number' || !ACTIONS.includes(parsed.action as (typeof ACTIONS)[number])) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision and a valid action are required.', 422, ctx.requestId);
    }
    const action = parsed.action as (typeof ACTIONS)[number];

    const claim = await claimIdempotencyKey(ctx.supabase, 'products:publication', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    try {
      const product = await loadProductResponse(ctx.supabase, env, params.id);
      if (!product) {
        await releaseIdempotencyKey(ctx.supabase, 'products:publication', idempotencyKey, leaseToken);
        return errorResponse('NOT_FOUND', `Product ${params.id} does not exist.`, 404, ctx.requestId);
      }

      let variantsParam: unknown = null;
      let mediaParam: unknown = null;
      let structuralParam: unknown = null;

      if (action === 'publish') {
        const readiness = await computeReadiness(ctx.supabase, product);
        if (!readiness.ready) {
          await releaseIdempotencyKey(ctx.supabase, 'products:publication', idempotencyKey, leaseToken);
          return errorResponse('PRINT_ASSETS_INCOMPLETE', readiness.blockers.join(' '), 422, ctx.requestId, {
            fieldErrors: { variants: readiness.blockers.join('; ') },
          });
        }

        mediaParam = product.draft.images.map((url, i) => ({ url, alt: null, position: i, is_primary: i === 0 }));

        if (product.draft.type === 'print') {
          variantsParam = buildPrintVariantSpecs(product.draft);
        } else {
          structuralParam = {
            category_slug: product.draft.category,
            num: product.draft.displayNumber,
            measure: product.draft.measure,
            price_pln: Math.round(product.draft.pricePln / 100),
            price_eur: Math.round(product.draft.priceEur / 100),
            price_gbp: Math.round(product.draft.priceGbp / 100),
            drop_id: product.draft.dropId ?? null,
            seo_title: null,
            seo_description: product.draft.seo?.pl ?? null,
          };
        }
      }

      const { error } = await ctx.supabase.rpc('publish_product_revision', {
        p_product_id: params.id,
        p_expected_revision: parsed.expectedRevision,
        p_action: action,
        p_actor_email: ctx.actorEmail,
        p_variants: variantsParam,
        p_media: mediaParam,
        p_structural: structuralParam,
      });

      if (error) {
        await releaseIdempotencyKey(ctx.supabase, 'products:publication', idempotencyKey, leaseToken);
        if (error.message?.includes('product_not_found')) {
          return errorResponse('NOT_FOUND', `Product ${params.id} does not exist.`, 404, ctx.requestId);
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
        if (error.message?.includes('print_assets_incomplete')) {
          return errorResponse('PRINT_ASSETS_INCOMPLETE', 'Brakuje zaakceptowanych proofów.', 422, ctx.requestId);
        }
        throw error;
      }

      const updated = await loadProductResponse(ctx.supabase, env, params.id);
      await completeIdempotencyKey(ctx.supabase, 'products:publication', idempotencyKey, leaseToken, 200, updated);
      return jsonResponse(updated);
    } catch (err) {
      await releaseIdempotencyKey(ctx.supabase, 'products:publication', idempotencyKey, leaseToken);
      throw err;
    }
  },
};
