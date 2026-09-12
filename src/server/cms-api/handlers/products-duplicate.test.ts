import { describe, expect, it, vi, beforeEach } from 'vitest';
import { productsDuplicateRoute } from './products-duplicate';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../mapping';

vi.mock('../idempotency');
vi.mock('../mapping');

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/products/prd_src/duplicate', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('productsDuplicateRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await productsDuplicateRoute.handler(req({ expectedRevision: 1 }, null), {} as CloudflareEnv, { id: 'prd_src' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('returns 404 and releases the lease when the source product is missing', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(null);
    const res = await productsDuplicateRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'prd_src' }, ctxWith(vi.fn()));
    expect(res.status).toBe(404);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('returns 409 on a revision mismatch', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue({ revision: 3, type: 'ceramic', draft: { type: 'ceramic', category: 'kubki', displayNumber: '01' } } as never);
    const res = await productsDuplicateRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'prd_src' }, ctxWith(vi.fn()));
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(3);
  });

  it('creates a new product with a fresh id distinct from the source', async () => {
    vi.mocked(mapping.loadProductResponse)
      .mockResolvedValueOnce({ revision: 1, type: 'ceramic', draft: { type: 'ceramic', category: 'kubki', displayNumber: '01' } } as never)
      .mockResolvedValueOnce({ id: 'prd_new' } as never);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await productsDuplicateRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'prd_src' }, ctxWith(rpc));
    expect(res.status).toBe(200);
    const [, params] = rpc.mock.calls[0];
    expect(params.p_id).not.toBe('prd_src');
    expect(params.p_id).toMatch(/^prd_[0-9a-f]{10}$/);
  });
});
