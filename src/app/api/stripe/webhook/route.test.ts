import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

// --- Stripe: only constructEventAsync matters for the payment_failed path ---
const constructEventAsync = vi.fn();
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ webhooks: { constructEventAsync }, refunds: { create: vi.fn() } }),
}));

// --- Cloudflare env (webhook secret + no conversion creds so trackPurchase no-ops) ---
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' } }),
}));

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

// --- Supabase: swapped per test ---
let supabaseImpl: unknown;
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => supabaseImpl }));

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

// --- Heavy collaborators unused on the failed path: neutralise to keep imports clean ---
vi.mock('@/lib/inpost', () => ({ getInPost: () => ({}) }));
vi.mock('@/lib/invoice', () => ({ createOrderInvoice: vi.fn() }));
vi.mock('@/lib/shipment', () => ({ createOrderShipment: vi.fn() }));
vi.mock('@/lib/email', () => ({ emailNewOrderToStudio: vi.fn(), emailOrderConfirmationToCustomer: vi.fn() }));
vi.mock('@/lib/resend-events', () => ({ sendPurchasedEvent: vi.fn() }));
vi.mock('@/lib/marketing/conversions', () => ({ sendPurchaseConversions: vi.fn() }));

import { POST } from './route';
import { createOrderInvoice } from '@/lib/invoice';

type Result = { data: unknown; error: unknown };

/** A chainable query stub whose `.eq()` returns itself and whose terminal method resolves `result`. */
function chain(terminal: 'select' | 'maybeSingle', result: Result) {
  const b: Record<string, unknown> = { eq: () => b };
  b[terminal] = async () => result;
  return b;
}

/**
 * Supabase fake for releaseHold. `ordersUpdate` is the `pending→failed` transition
 * result; `ordersSelect` is the retry-path fallback fetch; `pieceUpdate` is the
 * piece_state release. Records the piece_state update payload so tests can assert
 * the release actually ran (and with the right target status).
 */
function makeSupabase(plan: { ordersUpdate: Result; ordersSelect: Result; pieceUpdate: Result }) {
  const calls = { pieceUpdatePayload: undefined as unknown, pieceUpdated: false };
  const supabase = {
    from(table: string) {
      if (table === 'orders') {
        return {
          update: () => chain('select', plan.ordersUpdate),
          select: () => chain('maybeSingle', plan.ordersSelect),
        };
      }
      if (table === 'piece_state') {
        return {
          update: (payload: unknown) => {
            calls.pieceUpdatePayload = payload;
            calls.pieceUpdated = true;
            return chain('select', plan.pieceUpdate);
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { supabase, calls };
}

function failedEventRequest() {
  constructEventAsync.mockResolvedValue({
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_1' } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

describe('webhook releaseHold', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('first delivery: transitions pending→failed and relists the reserved pieces', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(true);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
  });

  it('retry after the order is already failed: still re-attempts the release (no stuck reserved pieces)', async () => {
    const { supabase, calls } = makeSupabase({
      // pending→failed update matches nothing on the retry (already failed)
      ordersUpdate: { data: [], error: null },
      // fallback fetch finds the already-failed order
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    // Without the retry-safe fallback the release would be skipped and pieces stay reserved.
    expect(calls.pieceUpdated).toBe(true);
  });
});

function refundedEventRequest(over: Partial<{ amount: number; amount_refunded: number; payment_intent: string }> = {}) {
  constructEventAsync.mockResolvedValue({
    type: 'charge.refunded',
    data: { object: { amount: 100, amount_refunded: 100, payment_intent: 'pi_1', ...over } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

describe('webhook releaseSale (F2)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('throws (so the route responds 5xx) when the refunded-CAS orders UPDATE errors, instead of silently returning false', async () => {
    const { supabase } = makeSupabase({
      ordersUpdate: { data: null, error: { message: 'db down' } },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: null, error: null },
    });
    supabaseImpl = supabase;

    await expect(POST(refundedEventRequest())).rejects.toThrow(/db down/);
  });
});

describe('webhook signature verification (F6)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  it('missing stripe-signature header → 400 + console.error + Sentry message', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      body: '{}',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_bad_signature');
    consoleErrorSpy.mockRestore();
  });

  it('signature verification failure (constructEventAsync throws) → 400 + console.error + Sentry message', async () => {
    constructEventAsync.mockRejectedValue(new Error('bad sig'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_bad' },
      body: '{}',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_bad_signature');
    consoleErrorSpy.mockRestore();
  });
});

// --- payment_intent.succeeded fakes: markPaid + (always-run) createShipment need
// coordinated `orders`/`piece_state`/`order_items` responses. A single chainable
// proxy resolves any `.eq()/.is()` chain to a scripted result, and records calls
// when asked (used by F10 to assert the failed-status UPDATE's CAS filter).
type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

function proxyChain(result: QueryResult, onCall?: (method: string, args: unknown[]) => void): unknown {
  return new Proxy(() => {}, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
      return (...args: unknown[]) => {
        onCall?.(prop, args);
        return proxyChain(result, onCall);
      };
    },
  });
}

function succeededEventRequest() {
  constructEventAsync.mockResolvedValue({
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1' } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

function makeSucceededSupabase(opts: {
  casUpdate: QueryResult;
  fallbackSelect?: QueryResult;
  shipmentLookup: QueryResult;
  soldCount?: QueryResult;
  ceramicCount?: QueryResult;
  variantRows?: QueryResult;
}) {
  const failedUpdateEqArgs: unknown[][] = [];
  const supabase = {
    from(table: string) {
      if (table === 'orders') {
        return {
          update: (payload: Record<string, unknown>) => {
            if (payload.status === 'paid') return proxyChain(opts.casUpdate);
            if (payload.status === 'failed') {
              return proxyChain({ data: null, error: null }, (method, args) => {
                if (method === 'eq') failedUpdateEqArgs.push(args);
              });
            }
            throw new Error(`unexpected orders.update payload: ${JSON.stringify(payload)}`);
          },
          select: (columns: string) => {
            if (columns.startsWith('id, status')) return proxyChain(opts.fallbackSelect ?? { data: null, error: null });
            if (columns === 'id') return proxyChain(opts.shipmentLookup);
            throw new Error(`unexpected orders.select columns: ${columns}`);
          },
        };
      }
      if (table === 'piece_state') {
        return {
          update: () => proxyChain({ data: null, error: null }),
          select: () => proxyChain(opts.soldCount ?? { count: 0, error: null }),
        };
      }
      if (table === 'order_items') {
        return {
          select: (columns: string, countOpts?: unknown) => {
            if (countOpts) return proxyChain(opts.ceramicCount ?? { count: 0, error: null });
            return proxyChain(opts.variantRows ?? { data: [], error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { supabase, failedUpdateEqArgs };
}

describe('webhook markPaid unknown payment_intent (F9b)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  it('logs and captures Sentry when no order exists at all for the payment_intent, and still responds 200', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      // .single() finding no row surfaces as PostgREST's zero-rows error, not a bare null
      fallbackSelect: { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
      shipmentLookup: { data: { id: 'o_other' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith('markPaid: no order found for payment_intent', 'pi_1');
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_unknown_payment_intent');
    consoleErrorSpy.mockRestore();
  });

  it('a transient DB error on the fallback fetch reports a lookup failure, NOT an unknown payment_intent', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbError = { code: 'XX000', message: 'db hiccup' };
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: null, error: dbError },
      shipmentLookup: { data: { id: 'o_other' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith('markPaid: order lookup failed for payment_intent', 'pi_1', dbError);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_order_lookup_failed');
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith('stripe_webhook_unknown_payment_intent');
    consoleErrorSpy.mockRestore();
  });
});

describe('webhook markPaid under-fulfillment failed-write CAS guard (F10)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('issues the failed-status UPDATE with an `.eq(\'status\', \'paid\')` filter', async () => {
    const { supabase, failedUpdateEqArgs } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 1, error: null }, // expected 1, fulfilled 0 → under-fulfilled
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(failedUpdateEqArgs).toContainEqual(['status', 'paid']);
  });
});

describe('webhook ensureInvoiced failure (F5)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
  });

  it('captures the exception in Sentry when invoicing throws, and the route still responds 200', async () => {
    vi.mocked(createOrderInvoice).mockRejectedValueOnce(new Error('invoice api down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // "Already processed" retry path: CAS matches nothing, fallback finds the paid
    // order — keeps this test isolated to ensureInvoiced (skips the newSale email block).
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
