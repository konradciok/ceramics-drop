import { beforeEach, describe, expect, it, vi } from 'vitest';

type PgError = { code: string; message: string } | null;

const reserveRpc = vi.fn<
  (fn: string, params: Record<string, unknown>) => Promise<{ data: string[]; error: PgError }>
>(async () => ({ data: [], error: null }));
// Terminal call of the status-scoped release chain:
// .update(...).eq('order_id', id).eq('status', 'reserved').select('product_id')
const releaseHold = vi.fn<
  (col1: string, val1: unknown, col2: string, val2: unknown) => Promise<{ data: unknown[]; error: PgError }>
>(async () => ({ data: [], error: null }));
const insertOrders = vi.fn(async () => ({ error: null as PgError }));
const insertOrderItems = vi.fn(async () => ({ error: null as PgError }));
const updateOrderStatus = vi.fn<
  (patch: Record<string, unknown>, col: string, val: unknown) => Promise<{ error: PgError }>
>(async () => ({ error: null }));
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
const orderAmountGBPPence = vi.fn(() => 1_900);
const toGrosze = vi.fn((v: number) => Math.round(v * 100));
const toEuroCents = vi.fn((v: number) => Math.round(v * 100));
const toGBPPence = vi.fn((v: number) => Math.round(v * 100));

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
          update: (patch: Record<string, unknown>) => ({
            eq: (col: string, val: unknown) => updateOrderStatus(patch, col, val),
          }),
          select: () => ({ eq: () => ({ maybeSingle: selectOrderStatus }) }),
        };
      }
      if (table === 'order_items') return { insert: insertOrderItems };
      if (table === 'piece_state') {
        return {
          update: () => ({
            eq: (col1: string, val1: unknown) => ({
              eq: (col2: string, val2: unknown) => ({
                select: () => releaseHold(col1, val1, col2, val2),
              }),
            }),
          }),
        };
      }
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
  orderAmountGBPPence,
  toGrosze,
  toEuroCents,
  toGBPPence,
}));

const sendCheckoutStartedEvent = vi.fn(async () => {});
vi.mock('@/lib/resend-events', () => ({ sendCheckoutStartedEvent }));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ ctx: { waitUntil: (p: Promise<unknown>) => void p } }),
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

  it('rejects a replay of a non-pending order with 409, frees the hold its own reserve call took, AND cancels the orphaned fresh PI', async () => {
    insertOrders.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    selectOrderStatus.mockResolvedValueOnce({ data: { status: 'expired' }, error: null });
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'order_conflict' });
    // This request re-reserved the pieces before hitting the conflict; leaving
    // that 15-min hold live would make the buyer's next (fresh-attemptId) click
    // collide with it — 409 unavailable, cart wiped. Release it, status-scoped
    // so rows a paid order already flipped to 'sold' are never touched.
    expect(releaseHold).toHaveBeenCalledWith('order_id', VALID_ATTEMPT_ID, 'status', 'reserved');
    // The PI create above minted a FRESH PaymentIntent (same idempotency key,
    // expired after ~24h) with no orders row and no cron path to reap it —
    // best-effort cancel it so it isn't stranded (F3 of the final review).
    expect(cancelPaymentIntent).toHaveBeenCalledWith('pi_test');
  });

  it('order_conflict replay: cancel rejection does not change the 409 response', async () => {
    insertOrders.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    selectOrderStatus.mockResolvedValueOnce({ data: { status: 'expired' }, error: null });
    cancelPaymentIntent.mockRejectedValueOnce(new Error('stripe down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('./route');
      const req = new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
      });

      const res = await POST(req);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'order_conflict' });
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('order_conflict'),
        'pi_test',
        expect.any(Error),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('releases the hold and responds 502 when Stripe PI creation fails', async () => {
    createPaymentIntent.mockRejectedValueOnce(new Error('stripe down'));
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'stripe_failed' });
    expect(releaseHold).toHaveBeenCalledWith('order_id', VALID_ATTEMPT_ID, 'status', 'reserved');
  });

  it('idempotency_key_in_use → 409 checkout_in_progress, hold NOT released (a concurrent same-attempt POST owns it)', async () => {
    createPaymentIntent.mockRejectedValueOnce(
      Object.assign(new Error('idempotency key in use'), { code: 'idempotency_key_in_use' }),
    );
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    // 409 checkout_in_progress (not 502 stripe_failed): the client keeps the
    // attemptId, so a retry replays onto the winner's checkout instead of a
    // fresh attempt that would 409-unavailable against its own live hold.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'checkout_in_progress' });
    // The winning tab's checkout is mid-flight on this same hold — releasing it
    // here would relist pieces its buyer is about to pay for (double-sell).
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('idempotency_error + a pending order already owns this attemptId → 409 order_conflict, hold NOT released', async () => {
    createPaymentIntent.mockRejectedValueOnce(
      Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
        type: 'idempotency_error',
      }),
    );
    selectOrderStatus.mockResolvedValueOnce({ data: { status: 'pending' }, error: null });
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'order_conflict' });
    // A live checkout (this same attemptId) owns the hold and possibly a
    // client_secret already in flight — releasing here would double-sell.
    expect(releaseHold).not.toHaveBeenCalled();
    // No PI was created (the create call itself threw) — nothing to cancel.
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('idempotency_error + no order row for this attemptId → release called, 502 stripe_failed', async () => {
    createPaymentIntent.mockRejectedValueOnce(
      Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
        raw: { type: 'idempotency_error' },
      }),
    );
    selectOrderStatus.mockResolvedValueOnce({ data: null, error: null });
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/checkout', {
      method: 'POST',
      body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'stripe_failed' });
    // No live order for this attemptId — a prior attempt died before the
    // orders insert. Safe to release, same as the generic Stripe-failure path.
    expect(releaseHold).toHaveBeenCalledWith('order_id', VALID_ATTEMPT_ID, 'status', 'reserved');
  });

  it('idempotency_error + order status lookup FAILS → 409 checkout_in_progress, no release, no cancel', async () => {
    createPaymentIntent.mockRejectedValueOnce(
      Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
        type: 'idempotency_error',
      }),
    );
    selectOrderStatus.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'db down' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('./route');
      const req = new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
      });

      const res = await POST(req);
      // A failed lookup must NOT be read as "no pending order": a live
      // checkout may own this hold, so releasing (or canceling anything)
      // on unknown state risks a double-sell. In-progress lets the client
      // keep the attemptId and re-run the check on retry.
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'checkout_in_progress' });
      expect(releaseHold).not.toHaveBeenCalled();
      expect(cancelPaymentIntent).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('duplicate-key insert (23505) + order status lookup FAILS → 409 checkout_in_progress, no release, no cancel', async () => {
    insertOrders.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    selectOrderStatus.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'db down' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('./route');
      const req = new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
      });

      const res = await POST(req);
      // If this is really a replay, the PI just created is the SAME live PI
      // (idempotent create) — canceling it on a guessed state would kill a
      // payment mid-flight, and releasing would relist held pieces.
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'checkout_in_progress' });
      expect(releaseHold).not.toHaveBeenCalled();
      expect(cancelPaymentIntent).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('fires checkout_started exactly once for a fresh order, and NOT on a replayed POST', async () => {
    const makeReq = () =>
      new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
      });
    const { POST } = await import('./route');

    // Fresh checkout → the abandoned-cart automation event fires.
    const res1 = await POST(makeReq());
    expect(res1.status).toBe(200);
    expect(sendCheckoutStartedEvent).toHaveBeenCalledTimes(1);

    // Replay of the same live attemptId (PK conflict, order still pending):
    // same client_secret back, but the automation must NOT re-trigger.
    insertOrders.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    selectOrderStatus.mockResolvedValueOnce({ data: { status: 'pending' }, error: null });
    const res2 = await POST(makeReq());
    expect(res2.status).toBe(200);
    expect(sendCheckoutStartedEvent).toHaveBeenCalledTimes(1);
  });

  const PRINT_ITEM = {
    product_id: 'print:fap01:50x70:true:false:black',
    unit_price: 42_000,
    variant: { size: '50x70', framed: true, mount: false, frameColour: 'black' },
  };
  const DE_ADDRESS = {
    street: 'Hauptstr.',
    building_number: '1',
    city: 'Berlin',
    post_code: '10115',
    country_code: 'DE',
  };
  const kurierDelivery = (address: Record<string, unknown> | null) => ({
    ok: true as const,
    delivery: {
      method: 'kurier',
      contact: { email: 'anna@example.com', first_name: 'Anna', last_name: 'Ciok', phone: null },
      target_point: null,
      address,
    },
  });

  describe('fulfilment_type on insert (Finding 8)', () => {
    it("writes 'pickup' for an odbior ceramic order", async () => {
      const { POST } = await import('./route');
      const res = await POST(
        new Request('http://localhost/api/checkout', {
          method: 'POST',
          body: JSON.stringify(makeCheckoutBody()),
        }),
      );
      expect(res.status).toBe(200);
      expect(insertOrders).toHaveBeenCalledWith(
        expect.objectContaining({ fulfilment_type: 'pickup' }),
      );
    });

    it("writes 'inpost' for a ceramic kurier order", async () => {
      validateDelivery.mockReturnValueOnce(
        kurierDelivery({ ...DE_ADDRESS, country_code: 'PL' }) as unknown as ReturnType<typeof validateDelivery>,
      );
      const { POST } = await import('./route');
      const res = await POST(
        new Request('http://localhost/api/checkout', {
          method: 'POST',
          body: JSON.stringify(makeCheckoutBody({ delivery_method: 'kurier' })),
        }),
      );
      expect(res.status).toBe(200);
      expect(insertOrders).toHaveBeenCalledWith(
        expect.objectContaining({ fulfilment_type: 'inpost' }),
      );
    });

    it("writes 'prodigi' for a print order (kurier to an EU address)", async () => {
      validateCart.mockReturnValueOnce({
        ok: true,
        items: [PRINT_ITEM],
      } as unknown as ReturnType<typeof validateCart>);
      validateDelivery.mockReturnValueOnce(
        kurierDelivery(DE_ADDRESS) as unknown as ReturnType<typeof validateDelivery>,
      );
      const { POST } = await import('./route');
      const res = await POST(
        new Request('http://localhost/api/checkout', {
          method: 'POST',
          body: JSON.stringify(makeCheckoutBody({ ids: [PRINT_ITEM.product_id], delivery_method: 'kurier' })),
        }),
      );
      expect(res.status).toBe(200);
      expect(insertOrders).toHaveBeenCalledWith(
        expect.objectContaining({ fulfilment_type: 'prodigi' }),
      );
      // Print carts never touch piece_state.
      expect(reserveRpc).not.toHaveBeenCalled();
    });
  });

  it('rejects a private-sale token combined with prints: 400, no reservation, no PaymentIntent (Finding 12)', async () => {
    validateCart.mockReturnValueOnce({
      ok: true,
      items: [PRINT_ITEM],
    } as unknown as ReturnType<typeof validateCart>);
    validateDelivery.mockReturnValueOnce(
      kurierDelivery(DE_ADDRESS) as unknown as ReturnType<typeof validateDelivery>,
    );
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify(
          makeCheckoutBody({
            ids: [PRINT_ITEM.product_id],
            delivery_method: 'kurier',
            private_sale_token: 'tok_secret_123',
          }),
        ),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'private_sale_prints_unsupported' });
    expect(reserveRpc).not.toHaveBeenCalled();
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(insertOrders).not.toHaveBeenCalled();
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
    // The orders insert itself failed — there is no row to mark failed.
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('marks the order failed after an order_items rollback so a retry cannot replay the canceled PI', async () => {
    const makeReq = () =>
      new Request('http://localhost/api/checkout', {
        method: 'POST',
        body: JSON.stringify(makeCheckoutBody({ attemptId: VALID_ATTEMPT_ID })),
      });
    const { POST } = await import('./route');

    // First POST: orders row inserted, but the items insert fails → rollback.
    insertOrderItems.mockResolvedValueOnce({ error: { code: '23000', message: 'boom' } });
    const res1 = await POST(makeReq());
    expect(res1.status).toBe(500);
    expect(cancelPaymentIntent).toHaveBeenCalledWith('pi_test');
    // The zombie 'pending' row must be neutralized, or a retry would replay
    // the now-canceled PI's client_secret as a valid checkout.
    expect(updateOrderStatus).toHaveBeenCalledWith(
      { status: 'failed' },
      'id',
      VALID_ATTEMPT_ID,
    );

    // Retry with the same attemptId: PK conflict, and the row now reads
    // 'failed' (exactly what the rollback above wrote) → order_conflict,
    // never a 200 carrying the dead PI's client_secret.
    insertOrders.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    selectOrderStatus.mockResolvedValueOnce({ data: { status: 'failed' }, error: null });
    const res2 = await POST(makeReq());
    expect(res2.status).toBe(409);
    expect(await res2.json()).toEqual({ error: 'order_conflict' });
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
