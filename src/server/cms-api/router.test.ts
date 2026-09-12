import { describe, expect, it } from 'vitest';
import { createRouter, type HandlerContext, type RouteDef } from './router';

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_test', supabase: {} as never };

describe('createRouter', () => {
  it('dispatches to the matching route and extracts path params', async () => {
    const routes: RouteDef[] = [
      {
        method: 'GET',
        path: '/v1/products/{id}',
        handler: async (_req, _env, params) => new Response(JSON.stringify(params)),
      },
    ];
    const dispatch = createRouter(routes);
    const res = await dispatch(new Request('https://x.test/v1/products/prd_abc'), {} as CloudflareEnv, ctx);
    expect(await res.json()).toEqual({ id: 'prd_abc' });
  });

  it('returns 404 NOT_IMPLEMENTED for an unknown path', async () => {
    const dispatch = createRouter([]);
    const res = await dispatch(new Request('https://x.test/v1/nope'), {} as CloudflareEnv, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_IMPLEMENTED');
  });

  it('returns 404 when the path matches but the method does not', async () => {
    const routes: RouteDef[] = [
      { method: 'GET', path: '/v1/products', handler: async () => new Response('ok') },
    ];
    const dispatch = createRouter(routes);
    const res = await dispatch(new Request('https://x.test/v1/products', { method: 'POST' }), {} as CloudflareEnv, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('decodes URL-encoded path params', async () => {
    const routes: RouteDef[] = [
      {
        method: 'GET',
        path: '/v1/products/{id}/proofs/{proofId}',
        handler: async (_req, _env, params) => new Response(JSON.stringify(params)),
      },
    ];
    const dispatch = createRouter(routes);
    const res = await dispatch(
      new Request('https://x.test/v1/products/prd_abc/proofs/9f1c1e2a%2Dtest'),
      {} as CloudflareEnv,
      ctx,
    );
    expect(await res.json()).toEqual({ id: 'prd_abc', proofId: '9f1c1e2a-test' });
  });
});
