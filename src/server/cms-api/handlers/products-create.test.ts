import { describe, expect, it, vi, beforeEach } from 'vitest';
import { productsCreateRoute } from './products-create';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../mapping';

vi.mock('../idempotency');
vi.mock('../mapping');

const validCeramic = {
  type: 'ceramic',
  category: 'kubki',
  displayNumber: '12',
  measure: '9x8',
  pricePln: 12000,
  priceEur: 2800,
  priceGbp: 2400,
  images: ['https://x.test/a.webp'],
  title: { pl: 'Kubek' },
  description: { pl: 'Opis' },
  showroom: false,
};

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/products', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('productsCreateRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(mapping.loadProductResponse).mockResolvedValue({ id: 'prd_abc' } as never);
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const res = await productsCreateRoute.handler(req(validCeramic, null), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('replays the stored response for a done idempotency key without calling rpc', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'prd_existing' } });
    const rpc = vi.fn();
    const res = await productsCreateRoute.handler(req(validCeramic), {} as CloudflareEnv, {}, ctxWith(rpc));
    expect(await res.json()).toEqual({ id: 'prd_existing' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns 409 when the key is already in flight', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await productsCreateRoute.handler(req(validCeramic), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(409);
  });

  it('returns 422 key_reuse when the same key carries a different body', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await productsCreateRoute.handler(req(validCeramic), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('releases the idempotency key and returns 422 on an invalid draft', async () => {
    const res = await productsCreateRoute.handler(req({ type: 'ceramic' }), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('creates the product with a prd_-prefixed id and completes the idempotency key on success', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await productsCreateRoute.handler(req(validCeramic), {} as CloudflareEnv, {}, ctxWith(rpc));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'create_product_with_draft',
      expect.objectContaining({ p_id: expect.stringMatching(/^prd_[0-9a-f]{10}$/), p_type: 'ceramic', p_category_slug: 'kubki' }),
    );
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalled();
  });

  it('retries with a new id on a 23505 unique_violation and releases the lease if all retries fail', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
    await expect(productsCreateRoute.handler(req(validCeramic), {} as CloudflareEnv, {}, ctxWith(rpc))).rejects.toBeTruthy();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
