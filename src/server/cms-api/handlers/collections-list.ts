import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { loadCollectionResponses } from '../collections-mapping';
import type { CollectionResponse } from '../types';

// GET /v1/collections has no query parameters and its response
// (`ResourceList = {items: Resource[]}`) carries no total/page/pageSize —
// see global-constraints.md item 5. Unlike products-list.ts, this handler
// must return every collection, unfiltered, unsorted, unpaginated.
export const collectionsListRoute: RouteDef = {
  method: 'GET',
  path: '/v1/collections',
  handler: async (_req, _env, _params, ctx) => {
    const { data, error } = await ctx.supabase.from('collections').select('id');
    if (error) throw error;

    const ids = (data ?? []).map((row) => row.id as string);
    const responses = await loadCollectionResponses(ctx.supabase, ids);
    const items = ids.map((id) => responses.get(id)).filter((c): c is CollectionResponse => Boolean(c));

    return jsonResponse({ items });
  },
};
