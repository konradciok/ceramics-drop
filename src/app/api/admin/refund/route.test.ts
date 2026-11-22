import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  adminSupabase: vi.fn(),
  refundsCreate: vi.fn(),
}));

const ENV = { fake: 'env' };

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: ENV }) }));
vi.mock('@/lib/admin/clients', () => ({
  adminSupabase: mocks.adminSupabase,
  adminStripe: () => ({ refunds: { create: mocks.refundsCreate } }),
}));

const ORDER_ID = '00000000-0000-0000-0000-000000000001';

function req(orderId = ORDER_ID) {
  return new Request('http://localhost/api/admin/refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  }) as Parameters<typeof POST>[0];
}

function supabaseForOrder(order: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: order, error: null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { from: vi.fn(() => ({ select })) };
}

describe('POST /api/admin/refund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refundsCreate.mockResolvedValue({ id: 're_1' });
  });

  it('refunds a paid order', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder({ payment_intent_id: 'pi_1', status: 'paid' }));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toContain('re_1');
    expect(mocks.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_1' },
      { idempotencyKey: 'admin_refund_pi_1' },
    );
  });

  it('a Stripe refund failure returns 502 and never touches fulfilment', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder({ payment_intent_id: 'pi_1', status: 'paid' }));
    mocks.refundsCreate.mockRejectedValueOnce(new Error('stripe down'));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({ error: 'stripe down' });
  });

  it('returns 409 for a non-paid order without creating a refund', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder({ payment_intent_id: 'pi_1', status: 'refunded' }));

    const res = await POST(req());

    expect(res.status).toBe(409);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });
});
