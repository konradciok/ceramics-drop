import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadProductResponse } from '../mapping';
import { mintProductPreviewToken } from '../preview';
import { SITE_URL } from '@/lib/site';

export const previewsRoute: RouteDef = {
  method: 'POST',
  path: '/v1/previews',
  handler: async (req, env, _params, ctx) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }
    const parsed = body as { resourceId?: unknown; revision?: unknown };
    if (typeof parsed.resourceId !== 'string' || typeof parsed.revision !== 'number') {
      return errorResponse('VALIDATION_FAILED', 'resourceId and revision are required.', 422, ctx.requestId);
    }

    const product = await loadProductResponse(ctx.supabase, env, parsed.resourceId);
    if (!product) {
      return errorResponse('NOT_FOUND', `Product ${parsed.resourceId} does not exist.`, 404, ctx.requestId);
    }

    if (!env.CMS_PREVIEW_SECRET) {
      return errorResponse('NOT_IMPLEMENTED', 'Preview minting is not configured in this environment.', 503, ctx.requestId);
    }

    const { token, expiresAt } = await mintProductPreviewToken(env.CMS_PREVIEW_SECRET, parsed.resourceId, parsed.revision);
    // The storefront does not yet branch on ?preview= for CMS-created
    // products (S2/S4 scope) — this URL is well-formed and the token
    // verifies, but rendering draft content from it is a later package.
    const category = product.type === 'ceramic' ? (product.draft as { category: string }).category : 'fine-art-prints';
    const url = `${SITE_URL}/en/${category}/${parsed.resourceId}?preview=${encodeURIComponent(token)}`;

    return jsonResponse({ url, expiresAt });
  },
};
