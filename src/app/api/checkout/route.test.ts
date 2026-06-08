import { beforeEach, describe, expect, it, vi } from 'vitest';

const reserveRpc = vi.fn(async () => ({ data: [], error: null }));
const releaseHold = vi.fn(async () => ({ error: null }));
const insertOrders = vi.fn(async () => ({ error: null }));
const insertOrderItems = vi.fn(async () => ({ error: null }));
const createPaymentIntent = vi.fn(async () => ({
  id: 'pi_test',
  client_secret: 'cs_test',
}));
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

vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: {
      create: createPaymentIntent,
      cancel: vi.fn(),
    },
  }),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    rpc: reserveRpc,
    from: (table: string) => {
      if (table === 'orders') return { insert: insertOrders };
      if (table === 'order_items') return { insert: insertOrderItems };
      if (table === 'piece_state') return { update: releaseHold };
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
});
