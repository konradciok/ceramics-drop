import { describe, expect, it, vi, beforeEach } from 'vitest';
import { productsSaveRoute } from './products-save';
import type { HandlerContext } from '../router';
import * as mapping from '../mapping';

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

function req(body: unknown) {
  return new Request('https://x.test/v1/products/prd_1', { method: 'PUT', body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('productsSaveRoute', () => {
  beforeEach(() => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue({ id: 'prd_1', revision: 2 } as never);
  });

  it('requires expectedRevision', async () => {
    const res = await productsSaveRoute.handler(req({ draft: validCeramic }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('validates the draft body', async () => {
    const res = await productsSaveRoute.handler(req({ expectedRevision: 1, draft: { type: 'ceramic' } }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('maps a product_not_found RPC error to 404', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'product_not_found' } });
    const res = await productsSaveRoute.handler(req({ expectedRevision: 1, draft: validCeramic }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(404);
  });

  it('maps a revision_conflict RPC error to 409 with currentRevision extracted from details', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=5' } });
    const res = await productsSaveRoute.handler(req({ expectedRevision: 1, draft: validCeramic }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(5);
  });

  it('saves successfully and returns the reloaded product', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await productsSaveRoute.handler(req({ expectedRevision: 1, draft: validCeramic }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'save_product_draft',
      expect.objectContaining({ p_product_id: 'prd_1', p_expected_revision: 1 }),
    );
  });
});
