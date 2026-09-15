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
