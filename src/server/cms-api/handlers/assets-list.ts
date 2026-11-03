import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { loadAssetList } from '../assets-mapping';

// GET /v1/assets has no query parameters and, like GET /v1/content, returns
// every listed asset unfiltered/unsorted/unpaginated beyond the mapping's own
// created_at-desc ordering (Global Constraint 5 — see collections-list.ts).
// Read-only: lists the ALREADY-WORKING print_fulfilment_assets table (Phase 0
// precondition per the plan) — see assets-mapping.ts for exactly which rows
// are listed and how they map onto the contract's Asset shape. Uploads made
// through POST /v1/uploads do not appear here until a later phase's job
// pipeline actually processes them into a print_fulfilment_assets row — this
// phase stops at "confirmed"/"awaiting processing" (see uploads-confirm.ts).
export const assetsListRoute: RouteDef = {
  method: 'GET',
  path: '/v1/assets',
  handler: async (_req, env, _params, ctx) => {
    const items = await loadAssetList(ctx.supabase, env);
    return jsonResponse({ items });
  },
};
