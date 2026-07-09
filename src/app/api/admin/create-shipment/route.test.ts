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

function req(orderId = ORDER_ID, recreate = false) {
  return new Request('http://localhost/api/admin/create-shipment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, recreate }),
  }) as Parameters<typeof POST>[0];
}

function supabaseForOrder(
  order: Record<string, unknown> | null,
  ceramicCount: number | { count: null; error: { message: string } } = 1,
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: order, error: null });
  const eqOrders = vi.fn(() => ({ maybeSingle }));
  const selectOrders = vi.fn(() => ({ eq: eqOrders }));

  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({ eq: updateEq }));

  const countResult =
    typeof ceramicCount === 'number'
      ? { count: ceramicCount, error: null }
      : ceramicCount;
  const isNull = vi.fn().mockResolvedValue(countResult);
  const eqItems = vi.fn(() => ({ is: isNull }));
  const selectItems = vi.fn(() => ({ eq: eqItems }));
  const from = vi.fn((table: string) => {
    if (table === 'order_items') return { select: selectItems };
    return { select: selectOrders, update };
  });
  return { from, update, updateEq };
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
      undefined,
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

  it('returns 500 when the ceramic count query fails', async () => {
    mocks.adminSupabase.mockReturnValue(
      supabaseForOrder(adminOrder(), { count: null, error: { message: 'db down' } }),
    );

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'db down' });
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('recreates a shipment when recreate is true', async () => {
    const sb = supabaseForOrder(adminOrder({ inpost_shipment_id: '42' }));
    mocks.adminSupabase.mockReturnValue(sb);

    const res = await POST(req(ORDER_ID, true));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ message: 'Nowa przesyłka utworzona.' });
    expect(sb.update).toHaveBeenCalledWith({
      inpost_shipment_id: null,
      inpost_tracking_number: null,
      inpost_dispatch_order_id: null,
      delivery_status: null,
      inpost_label_emailed_at: null,
    });
    expect(mocks.createOrderShipment).toHaveBeenCalledWith(
      'pi_1',
      expect.any(Object),
      { adoptExisting: false },
    );
  });

  it('returns 409 when recreate is requested without an existing shipment', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseForOrder(adminOrder()));

    const res = await POST(req(ORDER_ID, true));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'Brak przesyłki do zastąpienia.' });
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
