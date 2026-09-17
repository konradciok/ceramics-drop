import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { loadAllContentResources } from '../content-mapping';

// GET /v1/content has no query parameters and, like GET /v1/collections,
// returns every content resource unfiltered/unsorted/unpaginated (Global
// Constraint 5 — see collections-list.ts). Up to EDITABLE_DOCUMENTS.length x
// 4 Resources: one per (document, locale) pair — see content-mapping.ts.
export const contentListRoute: RouteDef = {
  method: 'GET',
  path: '/v1/content',
  handler: async (_req, _env, _params, _ctx) => {
    const items = await loadAllContentResources();
    return jsonResponse({ items });
  },
};
