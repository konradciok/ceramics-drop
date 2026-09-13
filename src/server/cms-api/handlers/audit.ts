import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';

type AuditRow = { id: string; product_id: string; revision: number | null; action: string; actor_email: string | null; created_at: string };

export const auditRoute: RouteDef = {
  method: 'GET',
  path: '/v1/audit',
  handler: async (req, _env, _params, ctx) => {
    const url = new URL(req.url);
    const resourceId = url.searchParams.get('resourceId');
    if (!resourceId) {
      return errorResponse('VALIDATION_FAILED', 'resourceId is required.', 422, ctx.requestId);
    }

    const { data, error } = await ctx.supabase
      .from('catalog_audit_log')
      .select('id, product_id, revision, action, actor_email, created_at')
      .eq('product_id', resourceId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const items = ((data ?? []) as AuditRow[]).map((row) => ({
      id: row.id,
      resourceId: row.product_id,
      revision: row.revision,
      action: row.action,
      actor: row.actor_email ?? 'system',
      createdAt: row.created_at,
    }));

    return jsonResponse({ items });
  },
};
