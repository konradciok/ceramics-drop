import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cfEnv, mockFrom, mockGetLabelPdf, mockLabelEmail, mockShippingEmail, mockReturnEmail } = vi.hoisted(() => ({
  cfEnv: { INPOST_WEBHOOK_TOKEN: 'tok_inpost' } as { INPOST_WEBHOOK_TOKEN?: string },
  mockFrom: vi.fn(),
  mockGetLabelPdf: vi.fn(),
  mockLabelEmail: vi.fn(),
  mockShippingEmail: vi.fn(),
  mockReturnEmail: vi.fn(),
}));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: cfEnv }),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('@/lib/carriers/inpost-shipx/client', () => ({ getInPost: () => ({ getLabelPdf: mockGetLabelPdf }) }));
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
  delivery_status: 'created' as string | null,
  inpost_tracking_number: null as string | null,
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
  /** How many status writes lose the compare-and-set (match 0 rows) before one wins. */
  casMisses?: number;
}) {
  const calls = {
    statusUpdates: [] as Record<string, unknown>[],
    /** `[method, column, value]` filters applied to each status write. */
    statusFilters: [] as unknown[][][],
    claims: [] as Record<string, unknown>[],
  };
  let casMisses = opts.casMisses ?? 0;
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
        if ('delivery_status' in p || 'inpost_tracking_number' in p) {
          calls.statusUpdates.push(p);
          const won = casMisses-- <= 0;
          const chain = makeChain({ data: won ? [{ id: 'o1' }] : [], error: null });
          const filters: unknown[][] = [];
          calls.statusFilters.push(filters);
          for (const m of ['eq', 'is']) {
            chain[m] = vi.fn((...args: unknown[]) => { filters.push([m, ...args]); return chain; });
          }
          return chain;
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
    expect((await POST(req('tok_inpos'))).status).toBe(401); // prefix of the real token
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('fails closed (401) when INPOST_WEBHOOK_TOKEN is %s', async (_label, secret) => {
    setup({ order: CERAMIC_ORDER });
    cfEnv.INPOST_WEBHOOK_TOKEN = secret;
    try {
      expect((await POST(req(null))).status).toBe(401);
      expect((await POST(req('anything'))).status).toBe(401);
      expect(mockFrom).not.toHaveBeenCalled();
    } finally {
      cfEnv.INPOST_WEBHOOK_TOKEN = 'tok_inpost';
    }
  });

  it('compares the token in constant time (the shared timingSafeEqual helper)', async () => {
    const helper = await import('@/lib/timing-safe-equal');
    const spy = vi.spyOn(helper, 'timingSafeEqual');
    setup({});
    await POST(req('tok_wrong'));
    expect(spy).toHaveBeenCalledWith('tok_wrong', 'tok_inpost');
    spy.mockRestore();
  });

  describe('status ordering (WH-02)', () => {
    it('forward move: stores the newer status with a compare-and-set on the status that was read', async () => {
      const calls = setup({ order: { ...CERAMIC_ORDER, delivery_status: 'confirmed', inpost_tracking_number: 'TRK77' } });

      const res = await POST(req('tok_inpost', { shipment_id: 77, status: 'out_for_delivery' }));

      expect(res.status).toBe(200);
      expect(calls.statusUpdates).toEqual([{ delivery_status: 'out_for_delivery' }]);
      expect(calls.statusFilters[0]).toEqual([
        ['eq', 'id', 'o1'],
        ['eq', 'delivery_status', 'confirmed'],
      ]);
    });

    it('a NULL stored status is CAS-matched with IS NULL', async () => {
      const calls = setup({ order: { ...CERAMIC_ORDER, delivery_status: null } });

      await POST(req('tok_inpost', { shipment_id: 77, status: 'created' }));

      expect(calls.statusFilters[0]).toContainEqual(['is', 'delivery_status', null]);
    });

    it('regression (delivered → created / confirmed): ignored, no status write, no "shipped" emails', async () => {
      const delivered = { ...CERAMIC_ORDER, delivery_status: 'delivered', inpost_tracking_number: 'TRK77' };
      const calls = setup({ order: delivered });

      const r1 = await POST(req('tok_inpost', { shipment_id: 77, status: 'created' }));
      const r2 = await POST(req('tok_inpost', { shipment_id: 77, status: 'confirmed', tracking_number: 'TRK77' }));

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(calls.statusUpdates).toEqual([]);
      expect(mockLabelEmail).not.toHaveBeenCalled();
      expect(mockShippingEmail).not.toHaveBeenCalled();
    });

    it('stage regression (ready_to_pickup → taken_by_courier) is ignored; a lateral move in a stage is kept', async () => {
      const calls = setup({ order: { ...CERAMIC_ORDER, delivery_status: 'ready_to_pickup' } });

      await POST(req('tok_inpost', { shipment_id: 77, status: 'taken_by_courier' }));
      await POST(req('tok_inpost', { shipment_id: 77, status: 'pickup_reminder_sent' }));

      expect(calls.statusUpdates).toEqual([{ delivery_status: 'pickup_reminder_sent' }]);
    });

    it('late confirmed after the courier took the parcel: no studio label email', async () => {
      setup({ order: { ...CERAMIC_ORDER, delivery_status: 'taken_by_courier', customer_notified_at: '2026-07-01T00:00:00Z' } });

      await POST(req('tok_inpost'));

      expect(mockLabelEmail).not.toHaveBeenCalled();
    });

    it('unknown status: not stored (logged), 200 so InPost stops retrying', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls = setup({ order: { ...CERAMIC_ORDER, delivery_status: 'delivered' } });

      const res = await POST(req('tok_inpost', { shipment_id: 77, status: '<anything-at-all>' }));

      expect(res.status).toBe(200);
      expect(calls.statusUpdates).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('inpost_unknown_status'));
      warn.mockRestore();
    });

    it('never overwrites a stored tracking number', async () => {
      const calls = setup({ order: { ...CERAMIC_ORDER, delivery_status: 'confirmed', inpost_tracking_number: 'TRK77' } });

      await POST(req('tok_inpost', { shipment_id: 77, status: 'taken_by_courier', tracking_number: 'EVIL1' }));

      expect(calls.statusUpdates).toEqual([{ delivery_status: 'taken_by_courier' }]);
    });

    it('lost CAS: re-reads and retries; still losing after 3 tries → 500 so InPost redelivers', async () => {
      const once = setup({ order: CERAMIC_ORDER, casMisses: 1 });
      expect((await POST(req('tok_inpost', { shipment_id: 77, status: 'taken_by_courier' }))).status).toBe(200);
      expect(once.statusUpdates).toHaveLength(2);

      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const always = setup({ order: CERAMIC_ORDER, casMisses: 99 });
      const res = await POST(req('tok_inpost', { shipment_id: 77, status: 'taken_by_courier' }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'status_conflict' });
      expect(always.statusUpdates).toHaveLength(3);
      err.mockRestore();
    });
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

    const res = await POST(req('tok_inpost', { shipment_id: 77, status: 'taken_by_courier' }));

    expect(res.status).toBe(200);
    expect(calls.statusUpdates[0]).toMatchObject({ delivery_status: 'taken_by_courier' });
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
