import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadProductResponse } from '../mapping';
import { mintProductPreviewToken, mintContentPreviewToken } from '../preview';
import { decodeContentResourceId, loadContentResource } from '../content-mapping';
import { editableDocument } from '@/lib/admin/content';
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
    if (
      typeof parsed.resourceId !== 'string' ||
      !Number.isSafeInteger(parsed.revision) ||
      (parsed.revision as number) < 0
    ) {
      return errorResponse('VALIDATION_FAILED', 'resourceId and revision are required.', 422, ctx.requestId);
    }
    const resourceId = parsed.resourceId;
    const revision = parsed.revision as number;

    // Task 5 — content preview. Preview's payload is a discriminated union
    // keyed by `kind` (preview.ts's PreviewPayload); which kind a given
    // resourceId mints depends on whether it decodes as
    // "${kind}:${slug}:${locale}" (content) or not (product) — the wire
    // request/response shape (Preview/PreviewResult) is unchanged (Task 5
    // brief: reuse the existing generic POST /v1/previews rather than a
    // dedicated content preview endpoint).
    const contentParts = decodeContentResourceId(resourceId);
    if (contentParts) {
      const resource = await loadContentResource(contentParts.kind, contentParts.slug, contentParts.locale, ctx.supabase);
      if (!resource) {
        return errorResponse('NOT_FOUND', `Content ${resourceId} does not exist.`, 404, ctx.requestId);
      }
      if (!env.CMS_PREVIEW_SECRET) {
        return errorResponse('NOT_IMPLEMENTED', 'Preview minting is not configured in this environment.', 503, ctx.requestId);
      }
      const { token, expiresAt } = await mintContentPreviewToken(env.CMS_PREVIEW_SECRET, resourceId, revision);
      // editableDocument is pure (no I/O) — safe to call directly for
      // publicPath even though decodeContentResourceId already validated
      // this kind/slug pair exists (same lookup, just needs the full
      // EditableContentDocument this time, not only its validity).
      const doc = editableDocument(contentParts.kind, contentParts.slug)!;
      // Locale-prefixed, unlike the product branch below (which hardcodes
      // 'en' — an existing simplification, not something this item
      // changes): content is genuinely locale-scoped, so using the
      // resource's own locale here is more correct than reusing that
      // hardcoded value. The storefront does not yet branch on ?preview=
      // for CmsApi-authored content either (same "well-formed, verifies,
      // not yet wired to draft rendering" posture as the product branch).
      const url = `${SITE_URL}/${contentParts.locale}${doc.publicPath}?preview=${encodeURIComponent(token)}`;
      return jsonResponse({ url, expiresAt });
    }

    const product = await loadProductResponse(ctx.supabase, env, resourceId);
    if (!product) {
      return errorResponse('NOT_FOUND', `Product ${resourceId} does not exist.`, 404, ctx.requestId);
    }

    if (!env.CMS_PREVIEW_SECRET) {
      return errorResponse('NOT_IMPLEMENTED', 'Preview minting is not configured in this environment.', 503, ctx.requestId);
    }

    const { token, expiresAt } = await mintProductPreviewToken(env.CMS_PREVIEW_SECRET, resourceId, revision);
    // The storefront does not yet branch on ?preview= for CMS-created
    // products (S2/S4 scope) — this URL is well-formed and the token
    // verifies, but rendering draft content from it is a later package.
    const category = product.type === 'ceramic' ? (product.draft as { category: string }).category : 'fine-art-prints';
    const url = `${SITE_URL}/en/${category}/${resourceId}?preview=${encodeURIComponent(token)}`;

    return jsonResponse({ url, expiresAt });
  },
};
