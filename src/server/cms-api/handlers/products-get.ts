import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadProductResponse } from '../mapping';

export const productsGetRoute: RouteDef = {
  method: 'GET',
  path: '/v1/products/{id}',
  handler: async (_req, env, params, ctx) => {
    const product = await loadProductResponse(ctx.supabase, env, params.id);
    if (!product) {
      return errorResponse('NOT_FOUND', `Product ${params.id} does not exist.`, 404, ctx.requestId);
    }
    return jsonResponse(product);
  },
};
