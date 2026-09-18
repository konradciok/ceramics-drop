import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { loadAllShippingRateResources } from '../shipping-rates-mapping';

// GET /v1/shipping-rates has no query parameters and its response
// (`ResourceList = {items: Resource[]}`) carries no total/page/pageSize — see
// global-constraints.md item 5 / collections-list.ts.
//
// There are exactly two resources, one per fulfilment track, so this list is
// always 2 items — or fewer only if the 20260917150000 migration was never
// applied, in which case an empty list is the honest answer for "this
// deployment has no editable shipping rates yet" rather than an error.
export const shippingRatesListRoute: RouteDef = {
  method: 'GET',
  path: '/v1/shipping-rates',
  handler: async (_req, _env, _params, ctx) => {
    const items = await loadAllShippingRateResources(ctx.supabase);
    return jsonResponse({ items });
  },
};
