import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  adminSupabase: vi.fn(),
  createOrderShipment: vi.fn(),
  getInPost: vi.fn(() => ({ createShipment: vi.fn(), getShipment: vi.fn(), getLabelPdf: vi.fn(), createDispatchOrder: vi.fn() })),
}));

vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('@/lib/shipment', () => ({ createOrderShipment: mocks.createOrderShipment }));
vi.mock('@/lib/inpost', () => ({ getInPost: mocks.getInPost }));

const ORDER_ID = '00000000-0000-0000-0000-000000000001';

function req(orderId = ORDER_ID) {
  return new Request('http://localhost/api/admin/create-shipment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  }) as Parameters<typeof POST>[0];
}

function supabaseForOrder(order: Record<string, unknown> | null, ceramicCount = 1) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: order, error: null });
  const eqOrders = vi.fn(() => ({ maybeSingle }));
  const selectOrders = vi.fn(() => ({ eq: eqOrders }));
  // countCeramicOrderItems chain: order_items → select(count) → eq → is
  const isNull = vi.fn().mockResolvedValue({ count: ceramicCount, error: null });
  const eqItems = vi.fn(() => ({ is: isNull }));
  const selectItems = vi.fn(() => ({ eq: eqItems }));
  const from = vi.fn((table: string) =>
    table === 'order_items' ? { select: selectItems } : { select: selectOrders },
  );
  return { from };
}

function adminOrder(overrides: Record<string, unknown> = {}) {
  return {
    payment_intent_id: 'pi_1',
    status: 'paid',
    delivery_method: 'paczkomat',
    inpost_shipment_id: null,
    ...overrides,
  };
}

describe('POST /api/admin/create-shipment', () => {
  beforeEach(() => {
    mocks.adminSupabase.mockReset();
    mocks.createOrderShipment.mockReset();
    mocks.getInPost.mockClear();
    mocks.createOrderShipment.mockResolvedValue(undefined);
  });

  it('creates a shipment for a paid shipment order', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder(adminOrder()));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ message: 'Przesyłka utworzona.' });
    expect(mocks.createOrderShipment).toHaveBeenCalledWith(
      'pi_1',
      expect.objectContaining({
        loadOrder: expect.any(Function),
        saveShipment: expect.any(Function),
        saveDispatchOrderId: expect.any(Function),
        inpost: expect.any(Object),
      }),
    );
  });

  it('returns idempotent success when a shipment already exists', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder(adminOrder({ inpost_shipment_id: '42' })));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ message: 'Przesyłka już istnieje.' });
    expect(mocks.createOrderShipment).toHaveBeenCalledOnce();
  });

  it('returns 409 when the order is not paid', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder(adminOrder({ status: 'pending' })));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('pending');
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('returns 409 for studio pickup', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder(adminOrder({ delivery_method: 'odbior' })));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'Odbiór osobisty nie wymaga przesyłki.' });
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('returns 409 for a print-only order and never calls InPost', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder(adminOrder({ delivery_method: 'kurier' }), 0));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('Prodigi');
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('surfaces shipment creation failures as 502', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder(adminOrder()));
    mocks.createOrderShipment.mockRejectedValueOnce(new Error('ShipX unavailable'));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({ error: 'ShipX unavailable' });
  });
});
