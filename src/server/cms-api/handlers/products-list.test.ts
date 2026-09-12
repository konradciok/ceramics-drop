import { describe, expect, it, vi } from 'vitest';
import { productsListRoute } from './products-list';
import type { HandlerContext } from '../router';

vi.mock('../mapping', () => ({
  loadProductResponses: vi.fn(async (_supabase: unknown, _env: unknown, ids: string[]) => {
    return new Map(
      ids.map((id) => [
        id,
        {
          id,
          type: 'ceramic',
          revision: 1,
          publishedRevision: null,
          status: 'draft',
          draft: { type: 'ceramic', images: ['a.webp'] },
          thumbnail: 'a.webp',
          proofs: [],
          availability: 'available',
        },
      ]),
    );
  }),
}));

function makeQuery(rows: { id: string }[], count: number, spy?: { orArg?: string }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.eq = self;
  builder.or = (arg: string) => {
    if (spy) spy.orArg = arg;
    return builder;
  };
  builder.order = self;
  builder.range = () => Promise.resolve({ data: rows, count, error: null });
  return builder;
}

function fakeSupabase(rows: { id: string }[], count: number, spy?: { orArg?: string }) {
  return { from: () => ({ select: () => makeQuery(rows, count, spy) }) } as never;
}

function ctxFor(supabase: unknown): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: supabase as never };
}

describe('productsListRoute', () => {
  it('returns items/total/page/pageSize from the query result', async () => {
    const supabase = fakeSupabase([{ id: 'k01' }, { id: 'k02' }], 2);
    const res = await productsListRoute.handler(new Request('https://x.test/v1/products'), {} as CloudflareEnv, {}, ctxFor(supabase));
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.items).toHaveLength(2);
  });

  it('strips filter metacharacters out of q before it reaches the .or() clause', async () => {
    const spy: { orArg?: string } = {};
    const supabase = fakeSupabase([], 0, spy);
    await productsListRoute.handler(
      new Request(`https://x.test/v1/products?q=${encodeURIComponent("x'),status.eq.archived,(")}`),
      {} as CloudflareEnv,
      {},
      ctxFor(supabase),
    );
    expect(spy.orArg).toBe('id.ilike.%xstatuseqarchived%,num.ilike.%xstatuseqarchived%');
  });

  it('clamps pageSize to 100 and defaults page to 1 for invalid input', async () => {
    const supabase = fakeSupabase([], 0);
    const res = await productsListRoute.handler(
      new Request('https://x.test/v1/products?pageSize=9999&page=abc'),
      {} as CloudflareEnv,
      {},
      ctxFor(supabase),
    );
    const body = await res.json();
    expect(body.pageSize).toBe(100);
    expect(body.page).toBe(1);
  });
});
