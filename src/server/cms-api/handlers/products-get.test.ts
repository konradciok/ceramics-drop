import { describe, expect, it, vi } from 'vitest';
import { productsGetRoute } from './products-get';
import type { HandlerContext } from '../router';

vi.mock('../mapping', () => ({
  loadProductResponse: vi.fn(async (_supabase: unknown, _env: unknown, id: string) => (id === 'prd_1' ? { id: 'prd_1' } : null)),
}));

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };

describe('productsGetRoute', () => {
  it('returns the product when found', async () => {
    const res = await productsGetRoute.handler(new Request('https://x.test/v1/products/prd_1'), {} as CloudflareEnv, { id: 'prd_1' }, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('prd_1');
  });

  it('returns 404 NOT_FOUND when the product does not exist', async () => {
    const res = await productsGetRoute.handler(new Request('https://x.test/v1/products/nope'), {} as CloudflareEnv, { id: 'nope' }, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });
});
