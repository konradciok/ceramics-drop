import { describe, expect, it, vi } from 'vitest';
import { collectionsListRoute } from './collections-list';
import type { HandlerContext } from '../router';

vi.mock('../collections-mapping', () => ({
  loadCollectionResponses: vi.fn(async (_supabase: unknown, ids: string[]) => {
    return new Map(
      ids.map((id) => [
        id,
        {
          id,
          kind: 'collections',
          name: `Collection ${id}`,
          revision: 1,
          publishedRevision: null,
          fields: [],
        },
      ]),
    );
  }),
}));

function fakeSupabase(rows: { id: string }[], error: unknown = null) {
  return {
    from: () => ({
      select: () => Promise.resolve({ data: error ? null : rows, error }),
    }),
  } as never;
}

function ctxFor(supabase: unknown): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: supabase as never };
}

describe('collectionsListRoute', () => {
  it('returns items with no total/page/pageSize fields', async () => {
    const supabase = fakeSupabase([{ id: 'col_1' }, { id: 'col_2' }]);
    const res = await collectionsListRoute.handler(new Request('https://x.test/v1/collections'), {} as CloudflareEnv, {}, ctxFor(supabase));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe('col_1');
    expect(body).not.toHaveProperty('total');
    expect(body).not.toHaveProperty('page');
    expect(body).not.toHaveProperty('pageSize');
    expect(Object.keys(body)).toEqual(['items']);
  });

  it('returns an empty items array when there are no collections', async () => {
    const supabase = fakeSupabase([]);
    const res = await collectionsListRoute.handler(new Request('https://x.test/v1/collections'), {} as CloudflareEnv, {}, ctxFor(supabase));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('ignores any query parameters present on the request', async () => {
    const supabase = fakeSupabase([{ id: 'col_1' }]);
    const res = await collectionsListRoute.handler(
      new Request('https://x.test/v1/collections?page=2&pageSize=5&q=whatever'),
      {} as CloudflareEnv,
      {},
      ctxFor(supabase),
    );
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body)).toEqual(['items']);
  });

  it('propagates a supabase error instead of swallowing it', async () => {
    const supabase = fakeSupabase([], new Error('boom'));
    await expect(
      collectionsListRoute.handler(new Request('https://x.test/v1/collections'), {} as CloudflareEnv, {}, ctxFor(supabase)),
    ).rejects.toThrow('boom');
  });
});
