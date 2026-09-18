import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { PRICING_RESOURCE_ID, loadPricingResource } from '../pricing-mapping';

export const pricingGetRoute: RouteDef = {
  method: 'GET',
  path: '/v1/pricing/{id}',
  handler: async (_req, _env, params, ctx) => {
    if (params.id !== PRICING_RESOURCE_ID) {
      return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
    }
    const resource = await loadPricingResource(ctx.supabase);
    if (!resource) {
      return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
    }
    return jsonResponse(resource);
  },
};
