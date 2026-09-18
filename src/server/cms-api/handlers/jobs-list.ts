import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { listJobRows, mapJobRowToResponse } from '../jobs-mapping';

// GET /v1/jobs has no query parameters and, like GET /v1/assets and GET
// /v1/content, returns every listed job unfiltered/unsorted beyond the
// mapping's own created_at-desc ordering (Global Constraint 5 — see
// collections-list.ts). Read-only: lists print_asset_jobs
// (supabase/migrations/20260917170000_print_asset_jobs.sql) — the durable
// job-queue table Phase 2 (Task 10) introduces.
export const jobsListRoute: RouteDef = {
  method: 'GET',
  path: '/v1/jobs',
  handler: async (_req, _env, _params, ctx) => {
    const rows = await listJobRows(ctx.supabase);
    return jsonResponse({ items: rows.map(mapJobRowToResponse) });
  },
};
