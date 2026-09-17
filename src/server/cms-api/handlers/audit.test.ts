import { describe, expect, it } from 'vitest';
import { auditRoute } from './audit';
import type { HandlerContext } from '../router';

function makeQuery(data: unknown[], spy?: { orArg?: string }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.or = (arg: string) => {
    if (spy) spy.orArg = arg;
    return builder;
  };
  builder.order = self;
  builder.limit = () => Promise.resolve({ data, error: null });
  return builder;
}

function ctxWith(rows: unknown[], spy?: { orArg?: string }): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { from: () => makeQuery(rows, spy) } as never };
}

describe('auditRoute', () => {
  it('requires resourceId', async () => {
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit'), {} as CloudflareEnv, {}, ctxWith([]));
    expect(res.status).toBe(422);
  });

  it('maps catalog_audit_log rows to the Audit shape (product-scoped row, unchanged)', async () => {
    const rows = [{ id: 'a1', product_id: 'prd_1', collection_id: null, revision: 3, action: 'draft_saved', actor_email: 'anna@studio.pl', created_at: '2026-09-12T10:00:00.000Z' }];
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=prd_1'), {} as CloudflareEnv, {}, ctxWith(rows));
    expect(await res.json()).toEqual({
      items: [{ id: 'a1', resourceId: 'prd_1', revision: 3, action: 'draft_saved', actor: 'anna@studio.pl', createdAt: '2026-09-12T10:00:00.000Z' }],
    });
  });

  it('maps a collection-scoped row (product_id null, collection_id set) to the Audit shape', async () => {
    const rows = [{ id: 'a2', product_id: null, collection_id: 'col_1', revision: 2, action: 'published', actor_email: 'anna@studio.pl', created_at: '2026-09-15T10:00:00.000Z' }];
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=col_1'), {} as CloudflareEnv, {}, ctxWith(rows));
    expect(await res.json()).toEqual({
      items: [{ id: 'a2', resourceId: 'col_1', revision: 2, action: 'published', actor: 'anna@studio.pl', createdAt: '2026-09-15T10:00:00.000Z' }],
    });
  });

  it('defaults actor to "system" when actor_email is null', async () => {
    const rows = [{ id: 'a1', product_id: 'prd_1', collection_id: null, revision: null, action: 'print_asset_publish', actor_email: null, created_at: '2026-09-12T10:00:00.000Z' }];
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=prd_1'), {} as CloudflareEnv, {}, ctxWith(rows));
    expect((await res.json()).items[0].actor).toBe('system');
  });

  it('queries with an .or() filter matching either product_id or collection_id', async () => {
    const spy: { orArg?: string } = {};
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=col_1'), {} as CloudflareEnv, {}, ctxWith([], spy));
    expect(res.status).toBe(200);
    expect(spy.orArg).toBe('product_id.eq.col_1,collection_id.eq.col_1');
  });

  it('strips filter metacharacters out of resourceId before it reaches the .or() clause (same guard as products-list.ts)', async () => {
    const spy: { orArg?: string } = {};
    await auditRoute.handler(
      new Request(`https://x.test/v1/audit?resourceId=${encodeURIComponent("col_1),product_id.eq.other,(")}`),
      {} as CloudflareEnv,
      {},
      ctxWith([], spy),
    );
    expect(spy.orArg).toBe('product_id.eq.col_1product_ideqother,collection_id.eq.col_1product_ideqother');
  });
});

// ---------------------------------------------------------------------------
// Content-shaped resourceId ("${kind}:${slug}:${locale}") — branches to
// cms_documents (id lookup) + cms_audit_log instead of catalog_audit_log.
// decodeContentResourceId/encodeContentResourceId are pure (no I/O), so
// these tests exercise the real implementation rather than mocking it.
// ---------------------------------------------------------------------------

type ContentAuditFakeRow = { id: string; actor_email: string | null; action: string; locale: string | null; version: number | null; created_at: string };

function ctxForContent(opts: { docRow: { id: string } | null; auditRows: ContentAuditFakeRow[]; docSpy?: { kind?: string; slug?: string }; auditSpy?: { documentId?: string; locale?: string } }): HandlerContext {
  const documentsTable = {
    select: () => ({
      eq: (col: string, value: string) => {
        if (opts.docSpy) opts.docSpy[col === 'kind' ? 'kind' : 'slug'] = value;
        return {
          eq: (col2: string, value2: string) => {
            if (opts.docSpy) opts.docSpy[col2 === 'kind' ? 'kind' : 'slug'] = value2;
            return { maybeSingle: async () => ({ data: opts.docRow, error: null }) };
          },
        };
      },
    }),
  };
  const auditTable = {
    select: () => ({
      eq: (col: string, value: string) => {
        if (opts.auditSpy) opts.auditSpy.documentId = col === 'document_id' ? value : opts.auditSpy.documentId;
        return {
          eq: (col2: string, value2: string) => {
            if (opts.auditSpy) opts.auditSpy.locale = col2 === 'locale' ? value2 : opts.auditSpy.locale;
            return {
              order: () => ({
                limit: () => Promise.resolve({ data: opts.auditRows, error: null }),
              }),
            };
          },
        };
      },
    }),
  };
  return {
    actorEmail: 'anna@studio.pl',
    requestId: 'req_1',
    supabase: {
      from: (table: string) => (table === 'cms_documents' ? documentsTable : auditTable),
    } as never,
  };
}

describe('auditRoute — content-shaped resourceId', () => {
  it('returns an empty list when no cms_documents row exists yet for the document', async () => {
    const ctx = ctxForContent({ docRow: null, auditRows: [] });
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=product_notes:kubki:pl'), {} as CloudflareEnv, {}, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('scopes the cms_audit_log query by document_id and locale, and reconstructs resourceId from the request', async () => {
    const docSpy: { kind?: string; slug?: string } = {};
    const auditSpy: { documentId?: string; locale?: string } = {};
    const rows: ContentAuditFakeRow[] = [
      { id: 'a1', actor_email: 'anna@studio.pl', action: 'draft_saved', locale: 'pl', version: null, created_at: '2026-09-17T10:00:00.000Z' },
    ];
    const ctx = ctxForContent({ docRow: { id: 'doc_1' }, auditRows: rows, docSpy, auditSpy });
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=product_notes:kubki:pl'), {} as CloudflareEnv, {}, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([
      { id: 'a1', resourceId: 'product_notes:kubki:pl', revision: null, action: 'draft_saved', actor: 'anna@studio.pl', createdAt: '2026-09-17T10:00:00.000Z' },
    ]);
    expect(docSpy).toEqual({ kind: 'product_notes', slug: 'kubki' });
    expect(auditSpy).toEqual({ documentId: 'doc_1', locale: 'pl' });
  });

  it('reports revision from the nullable version column when present', async () => {
    const rows: ContentAuditFakeRow[] = [
      { id: 'a2', actor_email: null, action: 'published', locale: 'en', version: 3, created_at: '2026-09-17T11:00:00.000Z' },
    ];
    const ctx = ctxForContent({ docRow: { id: 'doc_1' }, auditRows: rows });
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=page:home:en'), {} as CloudflareEnv, {}, ctx);
    const body = await res.json();
    expect(body.items[0].revision).toBe(3);
    expect(body.items[0].actor).toBe('system');
    expect(body.items[0].resourceId).toBe('page:home:en');
  });

  it('does not touch catalog_audit_log for a content-shaped resourceId', async () => {
    let calledCatalog = false;
    const ctx: HandlerContext = {
      actorEmail: 'anna@studio.pl',
      requestId: 'req_1',
      supabase: {
        from: (table: string) => {
          if (table === 'catalog_audit_log') calledCatalog = true;
          if (table === 'cms_documents') {
            return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
          }
          return { select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) }) };
        },
      } as never,
    };
    await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=product_notes:kubki:pl'), {} as CloudflareEnv, {}, ctx);
    expect(calledCatalog).toBe(false);
  });
});
