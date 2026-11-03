import type { RouteDef, HandlerContext } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { decodeContentResourceId, encodeContentResourceId } from '../content-mapping';
import type { ContentResourceIdParts } from '../content-mapping';

type AuditRow = {
  id: string;
  product_id: string | null;
  collection_id: string | null;
  revision: number | null;
  action: string;
  actor_email: string | null;
  created_at: string;
};

type ContentAuditRow = {
  id: string;
  document_id: string | null;
  actor_email: string | null;
  action: string;
  locale: string | null;
  version: number | null;
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

    // Content resource ids ("${kind}:${slug}:${locale}") route to
    // cms_audit_log (scoped by document_id + locale) instead of
    // catalog_audit_log — a structurally different table (Task 5 brief).
    const contentParts = decodeContentResourceId(resourceId);
    if (contentParts) {
      return contentAuditResponse(ctx, contentParts);
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

async function contentAuditResponse(ctx: HandlerContext, parts: ContentResourceIdParts) {
  // cms_audit_log rows are keyed by document_id (a cms_documents.id uuid),
  // not by (kind, slug) directly — resolve the document row first. A
  // document that has never been saved (no cms_documents row yet) simply
  // has no audit history: return an empty list rather than 404, matching
  // GET /v1/audit's existing "resourceId not found → empty items" posture
  // for products/collections (the catalog_audit_log branch above never
  // 404s on an unknown id either).
  const { data: docRow, error: docErr } = await ctx.supabase
    .from('cms_documents')
    .select('id')
    .eq('kind', parts.kind)
    .eq('slug', parts.slug)
    .maybeSingle();
  if (docErr) throw docErr;
  if (!docRow) return jsonResponse({ items: [] });

  const { data, error } = await ctx.supabase
    .from('cms_audit_log')
    .select('id, document_id, actor_email, action, locale, version, created_at')
    .eq('document_id', (docRow as { id: string }).id)
    .eq('locale', parts.locale)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  const items = ((data ?? []) as ContentAuditRow[]).map((row) => ({
    id: row.id,
    // Reconstructed from the request's own (kind, slug, locale) rather than
    // read off the row: cms_audit_log's `locale` column can legitimately be
    // null for some historical row shapes elsewhere in this table's use, so
    // trusting the validated request parts is simpler and always correct
    // for content, which is scoped to exactly one locale per resource id.
    resourceId: encodeContentResourceId(parts.kind, parts.slug, parts.locale),
    // `version` is nullable today for every row (Task 5's migration adds
    // the column, but content.ts's audit-log inserts stay unmodified and so
    // never populate it) — see 20260917130000_cms_audit_log_version.sql.
    revision: row.version,
    action: row.action,
    actor: row.actor_email ?? 'system',
    createdAt: row.created_at,
  }));

  return jsonResponse({ items });
}
