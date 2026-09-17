import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { decodeContentResourceId, loadContentResource } from '../content-mapping';

export const contentGetRoute: RouteDef = {
  method: 'GET',
  path: '/v1/content/{id}',
  handler: async (_req, _env, params, ctx) => {
    const parts = decodeContentResourceId(params.id);
    if (!parts) {
      return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
    }
    const resource = await loadContentResource(parts.kind, parts.slug, parts.locale);
    if (!resource) {
      return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
    }
    return jsonResponse(resource);
  },
};
