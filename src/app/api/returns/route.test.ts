import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createShipment: vi.fn(),
  getClientIp: vi.fn(() => '203.0.113.50'),
}));

vi.mock('@/lib/client-ip', () => ({ getClientIp: mocks.getClientIp }));

vi.mock('@/lib/inpost', () => ({
  getInPost: () => ({ createShipment: mocks.createShipment }),
}));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: {
      STUDIO_RETURN_FIRST_NAME: 'Anna',
      STUDIO_RETURN_LAST_NAME: 'Ciok',
      STUDIO_RETURN_EMAIL: 'studio@ciok.art',
      STUDIO_RETURN_PHONE: '+48600000001',
      STUDIO_RETURN_ADDRESS_STREET: 'Floriańska',
      STUDIO_RETURN_ADDRESS_BUILDING: '12',
      STUDIO_RETURN_ADDRESS_CITY: 'Kraków',
      STUDIO_RETURN_ADDRESS_POSTAL: '31-019',
      STUDIO_RETURN_POINT: 'WAW20A',
    },
  }),
}));

let supabaseImpl: unknown;
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => supabaseImpl }));

import { POST } from './route';

const ORDER_ID = '00000000-0000-0000-0000-000000000001';

const paidOrder = {
  id: ORDER_ID,
  status: 'paid',
  delivery_method: 'paczkomat',
  email: 'buyer@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Kowalska',
  receiver_phone: '+48111222333',
  locale: 'pl',
  inpost_return_shipment_id: null,
};

function req(orderId = ORDER_ID) {
  return new Request('http://localhost/api/returns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId }),
  });
}

type CeramicCountPlan = {
  count?: number;
  error?: { message: string } | null;
};

/** Supabase fake wired for loadOrder + ceramic count + saveReturn. */
function makeSupabase(plan: { order: typeof paidOrder | null; ceramic: CeramicCountPlan }) {
  return {
    from(table: string) {
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: plan.order, error: null }),
            }),
          }),
          update: () => ({
            eq: () => ({
              is: async () => ({ error: null }),
            }),
          }),
        };
      }
      if (table === 'order_items') {
        return {
          select: () => ({
            eq: () => ({
              is: async () => ({
                count: plan.ceramic.error ? null : (plan.ceramic.count ?? 0),
                error: plan.ceramic.error ?? null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe('POST /api/returns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createShipment.mockResolvedValue({ id: 77, status: 'created', tracking_number: 'RET001' });
  });

  it('returns 404 for a print-only paid order and does not call InPost', async () => {
    supabaseImpl = makeSupabase({ order: paidOrder, ceramic: { count: 0 } });

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
    expect(mocks.createShipment).not.toHaveBeenCalled();
  });

  it('creates a return shipment when the order has ceramic line items', async () => {
    supabaseImpl = makeSupabase({ order: paidOrder, ceramic: { count: 1 } });

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ return_shipment_id: '77', tracking_number: 'RET001' });
    expect(mocks.createShipment).toHaveBeenCalledOnce();
  });

  it('returns 500 when the ceramic count query fails', async () => {
    supabaseImpl = makeSupabase({
      order: paidOrder,
      ceramic: { error: { message: 'timeout' } },
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'internal_error' });
    expect(mocks.createShipment).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      'returns: failed',
      expect.objectContaining({ orderId: ORDER_ID }),
    );

    errSpy.mockRestore();
  });
});
