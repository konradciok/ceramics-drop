import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockGetLabelPdf, mockLabelEmail, mockShippingEmail, mockReturnEmail } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockGetLabelPdf: vi.fn(),
  mockLabelEmail: vi.fn(),
  mockShippingEmail: vi.fn(),
  mockReturnEmail: vi.fn(),
}));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: { INPOST_WEBHOOK_TOKEN: 'tok_inpost' } }),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('@/lib/inpost', () => ({ getInPost: () => ({ getLabelPdf: mockGetLabelPdf }) }));
vi.mock('@/lib/email', () => ({
  emailLabelToStudio: mockLabelEmail,
  emailShippingConfirmationToCustomer: mockShippingEmail,
  emailReturnLabelToCustomer: mockReturnEmail,
}));

import { POST } from './route';

function req(token: string | null, body: unknown = { shipment_id: 77, status: 'confirmed', tracking_number: 'TRK77' }) {
  const url = token
    ? `http://localhost/api/inpost/webhook?token=${token}`
    : 'http://localhost/api/inpost/webhook';
  return new Request(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const CERAMIC_ORDER = {
  id: 'o1',
  delivery_method: 'paczkomat',
  inpost_tracking_number: null,
  inpost_target_point: 'WAW20A',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Ciok',
  inpost_label_emailed_at: null,
  email: 'buyer@example.com',
  locale: 'pl',
  customer_notified_at: null,
};

/** Thenable chain covering the route's orders queries and claim updates. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  for (const m of ['select', 'eq', 'is']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

function setup(opts: {
  /** Lookup by inpost_shipment_id — null = no outbound order (e.g. a print order: never has one). */
  order?: Record<string, unknown> | null;
  /** Lookup by inpost_return_shipment_id (fallback branch). */
  returnOrder?: Record<string, unknown> | null;
}) {
  const calls = { statusUpdates: [] as Record<string, unknown>[], claims: [] as Record<string, unknown>[] };
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'orders') throw new Error(`unexpected table: ${table}`);
    return {
      select: () => ({
        eq: (col: string) =>
          makeChain({
            data: col === 'inpost_shipment_id' ? (opts.order ?? null) : (opts.returnOrder ?? null),
            error: null,
          }),
      }),
      update: (p: Record<string, unknown>) => {
        if ('delivery_status' in p) {
          calls.statusUpdates.push(p);
          return makeChain({ error: null });
        }
        calls.claims.push(p);
        return makeChain({ data: [{ id: 'o1' }], error: null });
      },
    };
  });
  return calls;
}

describe('POST /api/inpost/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLabelPdf.mockResolvedValue(new ArrayBuffer(8));
    mockLabelEmail.mockResolvedValue(undefined);
    mockShippingEmail.mockResolvedValue(undefined);
  });

  it('rejects a missing/invalid token with 401', async () => {
    setup({});
    expect((await POST(req(null))).status).toBe(401);
    expect((await POST(req('tok_wrong'))).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects an unparseable payload with 400', async () => {
    setup({});
    const res = await POST(req('tok_inpost', { nothing: 'useful' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unparseable' });
  });

  it('ceramic order + confirmed: mirrors status, emails the studio label AND the customer tracking email once each', async () => {
    const calls = setup({ order: CERAMIC_ORDER });

    const res = await POST(req('tok_inpost'));

    expect(res.status).toBe(200);
    expect(calls.statusUpdates[0]).toMatchObject({ delivery_status: 'confirmed', inpost_tracking_number: 'TRK77' });
    expect(mockLabelEmail).toHaveBeenCalledTimes(1);
    expect(mockShippingEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mockShippingEmail).mock.calls[0][0]).toMatchObject({
      order: expect.objectContaining({ id: 'o1', inpost_tracking_number: 'TRK77' }),
      locale: 'pl',
    });
  });

  it('non-confirmed status: mirrors the status but sends no emails', async () => {
    const calls = setup({ order: CERAMIC_ORDER });

    const res = await POST(req('tok_inpost', { shipment_id: 77, status: 'in_transit' }));

    expect(res.status).toBe(200);
    expect(calls.statusUpdates[0]).toMatchObject({ delivery_status: 'in_transit' });
    expect(mockLabelEmail).not.toHaveBeenCalled();
    expect(mockShippingEmail).not.toHaveBeenCalled();
  });

  it('already-notified order: no duplicate emails on a replayed confirmed event', async () => {
    setup({
      order: {
        ...CERAMIC_ORDER,
        inpost_label_emailed_at: '2026-07-01T00:00:00Z',
        customer_notified_at: '2026-07-01T00:00:00Z',
      },
    });

    const res = await POST(req('tok_inpost'));

    expect(res.status).toBe(200);
    expect(mockLabelEmail).not.toHaveBeenCalled();
    expect(mockShippingEmail).not.toHaveBeenCalled();
  });

  it('unknown shipment (prints never carry inpost_shipment_id): 200 received, ZERO emails', async () => {
    // A print order lives only in prodigi_orders — the InPost lookup finds
    // nothing and the return-shipment fallback finds nothing either. The
    // ceramic shipping email must never fire for it.
    setup({ order: null, returnOrder: null });

    const res = await POST(req('tok_inpost'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mockLabelEmail).not.toHaveBeenCalled();
    expect(mockShippingEmail).not.toHaveBeenCalled();
    expect(mockReturnEmail).not.toHaveBeenCalled();
  });
});
