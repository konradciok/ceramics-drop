import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { loadPricingResource } from '../pricing-mapping';

// GET /v1/pricing has no query parameters and its response (`ResourceList =
// {items: Resource[]}`) carries no total/page/pageSize — see
// global-constraints.md item 5 / collections-list.ts.
//
// Pricing is a singleton, so this list is always either exactly one item or —
// only if print_pricing_config's row is absent, i.e. the 20260807120000
// migration was never applied — empty. It is never an error: an empty list is
// the honest answer for "this deployment has no price list yet".
export const pricingListRoute: RouteDef = {
  method: 'GET',
  path: '/v1/pricing',
  handler: async (_req, _env, _params, ctx) => {
    const resource = await loadPricingResource(ctx.supabase);
    return jsonResponse({ items: resource ? [resource] : [] });
  },
};
