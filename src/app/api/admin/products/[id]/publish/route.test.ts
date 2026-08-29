import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({ adminSupabase: vi.fn() }));
vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));

const ROW = { id: 'k01', type: 'ceramic', category_slug: 'kubki', status: 'draft', published_at: null };

function supabase(opts: { data?: unknown; error?: { message: string } | null } = {}) {
  const {
    data = { ok: true, product: { ...ROW, status: 'active', published_at: '2026-07-17T12:00:00Z' } },
    error = null,
  } = opts;
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { supabase: { rpc }, rpc };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/products/k01/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}
const ctx = (id = 'k01') => ({ params: Promise.resolve({ id }) }) as Parameters<typeof POST>[1];

describe('POST /api/admin/products/[id]/publish', () => {
  beforeEach(() => vi.clearAllMocks());

  it('activates a draft through the guarded RPC → 200', async () => {
    const { supabase: sb, rpc } = supabase();
    mocks.adminSupabase.mockReturnValue(sb);

    const res = await POST(req({ status: 'active' }, { 'X-Admin-Actor-Email': 'anna@studio.pl' }), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).product.status).toBe('active');
    expect(rpc).toHaveBeenCalledWith('update_product_status_guarded', {
      p_product_id: 'k01',
      p_status: 'active',
      p_actor_email: 'anna@studio.pl',
    });
  });

  it('passes non-active transitions through the same atomic RPC', async () => {
    const product = { ...ROW, status: 'hidden', published_at: '2026-01-01T00:00:00Z' };
    const { supabase: sb, rpc } = supabase({ data: { ok: true, product } });
    mocks.adminSupabase.mockReturnValue(sb);

    await POST(req({ status: 'hidden' }), ctx());
    expect(rpc).toHaveBeenCalledWith('update_product_status_guarded', {
      p_product_id: 'k01',
      p_status: 'hidden',
      p_actor_email: null,
    });
  });

  it('rejects an invalid status → 400', async () => {
    const res = await POST(req({ status: 'sold' }), ctx());
    expect(res.status).toBe(400);
    expect(mocks.adminSupabase).not.toHaveBeenCalled();
  });

  it('unknown product id → 404', async () => {
    mocks.adminSupabase.mockReturnValue(
      supabase({ data: null, error: { message: 'product_not_found' } }).supabase,
    );
    const res = await POST(req({ status: 'active' }), ctx('zz99'));
    expect(res.status).toBe(404);
  });

  it('blocks print activation when fulfilment assets are incomplete → 409', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({
      data: {
        ok: false,
        error: 'print_assets_incomplete',
        missing: ['50x70_unframed'],
      },
    }).supabase);

    const res = await POST(req({ status: 'active' }), ctx('fap01'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'print_assets_incomplete',
      missing: ['50x70_unframed'],
    });
  });
});
