import { beforeEach, describe, expect, it, vi } from 'vitest';

type PgError = { code: string; message: string } | null;

const reserveRpc = vi.fn<
  (fn: string, params: Record<string, unknown>) => Promise<{ data: string[]; error: PgError }>
>(async () => ({ data: [], error: null }));
const releaseHold = vi.fn(async () => ({ error: null as PgError }));
const insertOrders = vi.fn(async () => ({ error: null as PgError }));
const insertOrderItems = vi.fn(async () => ({ error: null as PgError }));
const selectOrderStatus = vi.fn(async () => ({ data: { status: 'pending' } as { status: string } | null, error: null as PgError }));
const createPaymentIntent = vi.fn(async () => ({
  id: 'pi_test',
  client_secret: 'cs_test',
}));
const cancelPaymentIntent = vi.fn(async () => ({}));
const validateCart = vi.fn(() => ({
  ok: true as const,
  items: [{ product_id: 'k01', unit_price: 9_000 }],
}));
const validateDelivery = vi.fn(() => ({
  ok: true as const,
  delivery: {
    method: 'odbior',
    contact: {
      email: 'anna@example.com',
      first_name: 'Anna',
      last_name: 'Ciok',
      phone: null,
    },
    target_point: null,
    address: null,
  },
}));
const getClientIp = vi.fn(() => '203.0.113.50');
const orderAmountGrosze = vi.fn(() => 9_000);
const orderAmountEuroCents = vi.fn(() => 2_200);

vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: {
      create: createPaymentIntent,
      cancel: cancelPaymentIntent,
    },
  }),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    rpc: reserveRpc,
    from: (table: string) => {
      if (table === 'orders') {
        return {
          insert: insertOrders,
          select: () => ({ eq: () => ({ maybeSingle: selectOrderStatus }) }),
        };
      }
      if (table === 'order_items') return { insert: insertOrderItems };
      if (table === 'piece_state') return { update: () => ({ eq: releaseHold }) };
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

vi.mock('@/lib/checkout', () => ({
  validateCart,
}));

vi.mock('@/lib/shipx', () => ({
  validateDelivery,
}));

vi.mock('@/lib/client-ip', () => ({
  getClientIp,
}));

vi.mock('@/lib/pricing', () => ({
  orderAmountGrosze,
  orderAmountEuroCents,
}));

describe('POST /api/checkout', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns 429 after the per-IP checkout budget is exhausted', async () => {
    const { POST } = await import('./route');
    const makeReq = () =>
      new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify({
          ids: ['k01'],
          locale: 'pl',
          delivery_method: 'odbior',
          contact: {
            email: 'anna@example.com',
            first_name: 'Anna',
            last_name: 'Ciok',
          },
        }),
      });

    let lastResponse: Response | null = null;
    for (let i = 0; i < 31; i += 1) {
      lastResponse = await POST(makeReq());
    }

    expect(lastResponse?.status).toBe(429);
    expect(await lastResponse?.json()).toEqual({ error: 'rate_limited' });
    const retryAfter = Number(lastResponse?.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(reserveRpc).toHaveBeenCalledTimes(30);
    expect(createPaymentIntent).toHaveBeenCalledTimes(30);
  });

  it('shares one "unknown" bucket in production when the client IP is absent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    getClientIp.mockReturnValue(null as unknown as string);
    try {
      const { POST } = await import('./route');
      const makeReq = () =>
        new Request('http://localhost/api/checkout', {
          method: 'POST',
          body: JSON.stringify({
            ids: ['k01'],
            locale: 'pl',
            delivery_method: 'odbior',
            contact: { email: 'anna@example.com', first_name: 'Anna', last_name: 'Ciok' },
          }),
        });

      let lastResponse: Response | null = null;
      for (let i = 0; i < 31; i += 1) {
        lastResponse = await POST(makeReq());
      }

      // No IP, but production must not fail open — all 31 share the 'unknown' bucket.
      expect(lastResponse?.status).toBe(429);
      expect(reserveRpc).toHaveBeenCalledTimes(30);
    } finally {
      vi.unstubAllEnvs();
      getClientIp.mockReturnValue('203.0.113.50');
    }
  });

  it('rejects a withdrawn-family piece with 400 not_for_sale before reserving or charging', async () => {
    validateCart.mockReturnValueOnce(
      { ok: false, reason: 'not_for_sale' } as unknown as ReturnType<typeof validateCart>,
    );
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        ids: ['w03'],
        locale: 'pl',
        delivery_method: 'odbior',
        contact: { email: 'anna@example.com', first_name: 'Anna', last_name: 'Ciok' },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_for_sale' });
    // The payment boundary: no reservation, no Stripe PaymentIntent.
    expect(reserveRpc).not.toHaveBeenCalled();
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it('uses EUR currency when locale is es', async () => {
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        ids: ['k01'],
        locale: 'es',
        delivery_method: 'odbior',
        contact: { email: 'anna@example.com', first_name: 'Anna', last_name: 'Ciok' },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'eur' }),
      expect.anything(),
    );
  });

  it('uses PLN currency when locale is pl', async () => {
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        ids: ['k01'],
        locale: 'pl',
        delivery_method: 'odbior',
        contact: { email: 'anna@example.com', first_name: 'Anna', last_name: 'Ciok' },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'pln' }),
      expect.anything(),
    );
  });

  it('passes the payment_method_configuration to Stripe', async () => {
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        ids: ['k01'],
        locale: 'pl',
        delivery_method: 'odbior',
        contact: { email: 'anna@example.com', first_name: 'Anna', last_name: 'Ciok' },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_method_configuration: 'pmc_1QiwdYJ0KFK9lrjHUV93dONs',
      }),
      expect.anything(),
    );
  });

  const VALID_ATTEMPT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  const makeCheckoutBody = (overrides: Record<string, unknown> = {}) => ({
    ids: ['k01'],
    locale: 'pl',
    delivery_method: 'odbior',
    contact: { email: 'anna@example.com', first_name: 'Anna', last_name: 'Ciok' },
    ...overrides,
  });

  it('passes a Stripe idempotency key derived from the supplied attemptId', async () => {
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.anything(),
      { idempotencyKey: `pi_create_${VALID_ATTEMPT_ID}` },
    );
  });

  it('uses a valid supplied attemptId as the order id (reserve RPC + orders insert)', async () => {
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(reserveRpc).toHaveBeenCalledWith(
      'reserve_pieces',
      expect.objectContaining({ p_order_id: VALID_ATTEMPT_ID }),
    );
    expect(insertOrders).toHaveBeenCalledWith(
      expect.objectContaining({ id: VALID_ATTEMPT_ID }),
    );
  });

  it('falls back to a server-generated order id when attemptId is absent or malformed (no 400)', async () => {
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: 'not-a-uuid' })),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const [, rpcArgs] = reserveRpc.mock.calls[0];
    expect(rpcArgs.p_order_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(rpcArgs.p_order_id).not.toBe('not-a-uuid');
  });

  it('replays a duplicate-key orders insert (23505) as a success: same client_secret, no cancel, no release', async () => {
    insertOrders.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    selectOrderStatus.mockResolvedValueOnce({ data: { status: 'pending' }, error: null });
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ client_secret: 'cs_test' });
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
    expect(insertOrderItems).not.toHaveBeenCalled();
  });

  it('rejects a replay whose existing order is no longer pending (already paid/expired)', async () => {
    insertOrders.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    selectOrderStatus.mockResolvedValueOnce({ data: { status: 'paid' }, error: null });
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'order_conflict' });
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('rolls back (cancels PI + releases pieces) on a genuine, non-23505 orders-insert failure', async () => {
    insertOrders.mockResolvedValueOnce({ error: { code: '23000', message: 'other failure' } });
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'order_persist_failed' });
    expect(cancelPaymentIntent).toHaveBeenCalledWith('pi_test');
    expect(releaseHold).toHaveBeenCalled();
  });

  it('logs (does not throw) when the rollback PI cancel itself fails', async () => {
    insertOrders.mockResolvedValueOnce({ error: { code: '23000', message: 'other failure' } });
    cancelPaymentIntent.mockRejectedValueOnce(new Error('stripe down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('./route');
      const req = new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
      });

      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(errSpy).toHaveBeenCalledWith(
        expect.any(String),
        'pi_test',
        expect.any(Error),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
