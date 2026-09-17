import { describe, expect, it, vi } from 'vitest';
import { contentListRoute } from './content-list';
import type { HandlerContext } from '../router';

vi.mock('../content-mapping', () => ({
  loadAllContentResources: vi.fn(async () => [
    { id: 'product_notes:kubki:pl', kind: 'content', name: 'kubki', revision: 1, publishedRevision: null, fields: [] },
    { id: 'product_notes:kubki:en', kind: 'content', name: 'kubki', revision: 0, publishedRevision: null, fields: [] },
  ]),
}));

function ctxFor(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

describe('contentListRoute', () => {
  it('returns items with no total/page/pageSize fields', async () => {
    const res = await contentListRoute.handler(new Request('https://x.test/v1/content'), {} as CloudflareEnv, {}, ctxFor());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(Object.keys(body)).toEqual(['items']);
  });

  it('ignores any query parameters present on the request', async () => {
    const res = await contentListRoute.handler(
      new Request('https://x.test/v1/content?page=2&pageSize=5'),
      {} as CloudflareEnv,
      {},
      ctxFor(),
    );
    const body = await res.json();
    expect(body.items).toHaveLength(2);
  });

  it('returns the mapped content resources verbatim', async () => {
    const res = await contentListRoute.handler(new Request('https://x.test/v1/content'), {} as CloudflareEnv, {}, ctxFor());
    const body = await res.json();
    expect(body.items[0].id).toBe('product_notes:kubki:pl');
    expect(body.items[1].id).toBe('product_notes:kubki:en');
  });
});
