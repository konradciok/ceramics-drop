import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';

type AuditRow = {
  id: string;
  product_id: string | null;
  collection_id: string | null;
  revision: number | null;
  action: string;
  actor_email: string | null;
  created_at: string;
};

export const auditRoute: RouteDef = {
  method: 'GET',
  path: '/v1/audit',
  handler: async (req, _env, _params, ctx) => {
    const url = new URL(req.url);
    const resourceId = url.searchParams.get('resourceId');
    if (!resourceId) {
      return errorResponse('VALIDATION_FAILED', 'resourceId is required.', 422, ctx.requestId);
    }

    // catalog_audit_log rows are scoped by exactly one of product_id /
    // collection_id (20260915120000_cms_api_collections.sql's
    // num_nonnulls(product_id, collection_id) = 1 check), so a single
    // resourceId must match either column. Same filter-injection guard as
    // products-list.ts's `q` handling — resourceId now feeds a PostgREST
    // .or() filter string instead of a single .eq(), so comma/paren/dot
    // metacharacters must be stripped first (product/collection ids are
    // always prd_/col_ + hex, so this never rejects a real id).
    const safeResourceId = resourceId.replace(/[^a-zA-Z0-9_-]/g, '');

    const { data, error } = await ctx.supabase
      .from('catalog_audit_log')
      .select('id, product_id, collection_id, revision, action, actor_email, created_at')
      .or(`product_id.eq.${safeResourceId},collection_id.eq.${safeResourceId}`)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const items = ((data ?? []) as AuditRow[]).map((row) => ({
      id: row.id,
      resourceId: row.product_id ?? row.collection_id,
      revision: row.revision,
      action: row.action,
      actor: row.actor_email ?? 'system',
      createdAt: row.created_at,
    }));

    return jsonResponse({ items });
  },
};
