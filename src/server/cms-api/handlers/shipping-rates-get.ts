import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { isShippingRateId, loadShippingRateResource } from '../shipping-rates-mapping';

export const shippingRatesGetRoute: RouteDef = {
  method: 'GET',
  path: '/v1/shipping-rates/{id}',
  handler: async (_req, _env, params, ctx) => {
    if (!isShippingRateId(params.id)) {
      return errorResponse('NOT_FOUND', `Shipping rates ${params.id} do not exist.`, 404, ctx.requestId);
    }
    const resource = await loadShippingRateResource(ctx.supabase, params.id);
    if (!resource) {
      return errorResponse('NOT_FOUND', `Shipping rates ${params.id} do not exist.`, 404, ctx.requestId);
    }
    return jsonResponse(resource);
  },
};
