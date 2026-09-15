import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadCollectionResponse } from '../collections-mapping';

export const collectionsGetRoute: RouteDef = {
  method: 'GET',
  path: '/v1/collections/{id}',
  handler: async (_req, _env, params, ctx) => {
    const collection = await loadCollectionResponse(ctx.supabase, params.id);
    if (!collection) {
      return errorResponse('NOT_FOUND', `Collection ${params.id} does not exist.`, 404, ctx.requestId);
    }
    return jsonResponse(collection);
  },
};
