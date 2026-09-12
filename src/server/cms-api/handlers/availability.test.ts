import { describe, expect, it, vi } from 'vitest';
import { availabilityRoute } from './availability';
import type { HandlerContext } from '../router';
import * as mapping from '../mapping';

vi.mock('../mapping');

function req(body: unknown) {
  return new Request('https://x.test/v1/products/k01/availability', { method: 'PUT', body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

const ceramicProduct = { id: 'k01', type: 'ceramic', revision: 2 } as never;
const printProduct = { id: 'fap001', type: 'print', revision: 2 } as never;

describe('availabilityRoute', () => {
  it('requires expectedRevision/availability/showroom', async () => {
    const res = await availabilityRoute.handler(req({ availability: 'sold' }), {} as CloudflareEnv, { id: 'k01' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('returns 404 when the product does not exist', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(null);
    const res = await availabilityRoute.handler(req({ expectedRevision: 2, availability: 'sold', showroom: false }), {} as CloudflareEnv, { id: 'k01' }, ctxWith(vi.fn()));
    expect(res.status).toBe(404);
  });

  it('rejects a print product (ceramics-only)', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(printProduct);
    const res = await availabilityRoute.handler(req({ expectedRevision: 2, availability: 'sold', showroom: false }), {} as CloudflareEnv, { id: 'fap001' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('returns 409 on a revision mismatch', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const res = await availabilityRoute.handler(req({ expectedRevision: 1, availability: 'sold', showroom: false }), {} as CloudflareEnv, { id: 'k01' }, ctxWith(vi.fn()));
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(2);
  });

  it('maps availability="showroom" to piece_availability=available + showroom=true', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await availabilityRoute.handler(req({ expectedRevision: 2, availability: 'showroom', showroom: false }), {} as CloudflareEnv, { id: 'k01' }, ctxWith(rpc));
    expect(rpc).toHaveBeenCalledWith('set_piece_availability_guarded', expect.objectContaining({ p_availability: 'available', p_showroom: true }));
  });

  it('maps a reservation_active RPC error to 409 RESERVATION_ACTIVE', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'reservation_active' } });
    const res = await availabilityRoute.handler(req({ expectedRevision: 2, availability: 'sold', showroom: false }), {} as CloudflareEnv, { id: 'k01' }, ctxWith(rpc));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RESERVATION_ACTIVE');
  });

  it('succeeds and returns the reloaded product', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValueOnce(ceramicProduct).mockResolvedValueOnce({ id: 'k01', availability: 'sold' } as never);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await availabilityRoute.handler(req({ expectedRevision: 2, availability: 'sold', showroom: false }), {} as CloudflareEnv, { id: 'k01' }, ctxWith(rpc));
    expect(res.status).toBe(200);
    expect((await res.json()).availability).toBe('sold');
  });
});
