import { describe, expect, it } from 'vitest';
import { auditRoute } from './audit';
import type { HandlerContext } from '../router';

function makeQuery(data: unknown[]) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.order = self;
  builder.limit = () => Promise.resolve({ data, error: null });
  return builder;
}

function ctxWith(rows: unknown[]): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { from: () => makeQuery(rows) } as never };
}

describe('auditRoute', () => {
  it('requires resourceId', async () => {
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit'), {} as CloudflareEnv, {}, ctxWith([]));
    expect(res.status).toBe(422);
  });

  it('maps catalog_audit_log rows to the Audit shape', async () => {
    const rows = [{ id: 'a1', product_id: 'prd_1', revision: 3, action: 'draft_saved', actor_email: 'anna@studio.pl', created_at: '2026-09-12T10:00:00.000Z' }];
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=prd_1'), {} as CloudflareEnv, {}, ctxWith(rows));
    expect(await res.json()).toEqual({
      items: [{ id: 'a1', resourceId: 'prd_1', revision: 3, action: 'draft_saved', actor: 'anna@studio.pl', createdAt: '2026-09-12T10:00:00.000Z' }],
    });
  });

  it('defaults actor to "system" when actor_email is null', async () => {
    const rows = [{ id: 'a1', product_id: 'prd_1', revision: null, action: 'print_asset_publish', actor_email: null, created_at: '2026-09-12T10:00:00.000Z' }];
    const res = await auditRoute.handler(new Request('https://x.test/v1/audit?resourceId=prd_1'), {} as CloudflareEnv, {}, ctxWith(rows));
    expect((await res.json()).items[0].actor).toBe('system');
  });
});
