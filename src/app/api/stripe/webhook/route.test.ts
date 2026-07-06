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
import { emailNewOrderToStudio, emailOrderConfirmationToCustomer } from '@/lib/email';
import { sendPurchasedEvent } from '@/lib/resend-events';

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
  /** The `id, email, ... , confirmation_email_sent_at, studio_email_sent_at` load. */
  emailOrderSelect?: QueryResult;
  /** Result of the atomic `studio_email_sent_at IS NULL` claim UPDATE. */
  studioClaim?: QueryResult;
  /** Result of the atomic `confirmation_email_sent_at IS NULL` claim UPDATE. */
  confirmClaim?: QueryResult;
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
            if ('studio_email_sent_at' in payload) {
              return proxyChain(opts.studioClaim ?? { data: [], error: null });
            }
            if ('confirmation_email_sent_at' in payload) {
              return proxyChain(opts.confirmClaim ?? { data: [], error: null });
            }
            throw new Error(`unexpected orders.update payload: ${JSON.stringify(payload)}`);
          },
          select: (columns: string) => {
            if (columns.startsWith('id, status')) return proxyChain(opts.fallbackSelect ?? { data: null, error: null });
            if (columns === 'id') return proxyChain(opts.shipmentLookup);
            if (columns.startsWith('id, email')) return proxyChain(opts.emailOrderSelect ?? { data: null, error: null });
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

  // NOTE: both tests below feed a not-found `shipmentLookup` (mirroring the
  // real `orders.select('id').eq('payment_intent_id', pi).single()` call in
  // createShipment). An unknown/un-lookupable payment_intent has no orders row
  // for ANY query, so createShipment's own lookup throws "order lookup failed"
  // and — since createShipment runs unconditionally after markPaid and nothing
  // in this route catches that throw — the route itself throws. In production
  // that surfaces as a 5xx, and Stripe retries the delivery (redelivering this
  // same event, so the Sentry message below fires again on every retry until
  // fixed). A prior version of these tests faked `shipmentLookup` as a found
  // order (`{ id: 'o_other' }`), which let createShipment succeed and asserted
  // a 200 the real system never produces for an unknown payment_intent.
  it('logs and captures Sentry when no order exists at all for the payment_intent, then throws via createShipment\'s own lookup (real 5xx/retry path)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      // .single() finding no row surfaces as PostgREST's zero-rows error, not a bare null
      fallbackSelect: { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
      shipmentLookup: { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/createShipment: order lookup failed/);

    expect(consoleErrorSpy).toHaveBeenCalledWith('markPaid: no order found for payment_intent', 'pi_1');
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_unknown_payment_intent');
    consoleErrorSpy.mockRestore();
  });

  it('a transient DB error on the fallback fetch reports a lookup failure, NOT an unknown payment_intent, then throws via createShipment\'s own lookup (real 5xx/retry path)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbError = { code: 'XX000', message: 'db hiccup' };
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: null, error: dbError },
      // Same underlying DB hiccup — createShipment's independent lookup query
      // fails the same way.
      shipmentLookup: { data: null, error: dbError },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/createShipment: order lookup failed/);

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
    // order. emailOrderSelect is left unset (defaults to a null row) so the email
    // block no-ops, keeping this test isolated to ensureInvoiced.
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

describe('webhook email idempotency on retry (F1)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(emailNewOrderToStudio).mockClear();
    vi.mocked(emailOrderConfirmationToCustomer).mockClear();
    vi.mocked(sendPurchasedEvent).mockClear();
  });

  const unclaimedOrderRow = {
    id: 'o1',
    email: 'buyer@example.com',
    total: 10000,
    currency: 'pln',
    delivery_method: 'paczkomat',
    receiver_first_name: 'Ann',
    receiver_last_name: 'K',
    inpost_target_point: 'WAW01',
    locale: 'pl',
    confirmation_email_sent_at: null,
    studio_email_sent_at: null,
  };

  it('retry on an already-paid order (CAS misses, fallback finds paid) with both guards unclaimed: sends BOTH emails and claims both columns', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      emailOrderSelect: { data: unclaimedOrderRow, error: null },
      studioClaim: { data: [{ id: 'o1' }], error: null },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(emailNewOrderToStudio).toHaveBeenCalledTimes(1);
    expect(emailOrderConfirmationToCustomer).toHaveBeenCalledTimes(1);
    // Retry path (newSale=false): abandoned-checkout cancellation must not re-fire.
    expect(sendPurchasedEvent).not.toHaveBeenCalled();
  });

  it('already-sent: order paid with both columns already claimed sends nothing', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      emailOrderSelect: {
        data: {
          ...unclaimedOrderRow,
          confirmation_email_sent_at: '2026-07-01T00:00:00.000Z',
          studio_email_sent_at: '2026-07-01T00:00:00.000Z',
        },
        error: null,
      },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(emailNewOrderToStudio).not.toHaveBeenCalled();
    expect(emailOrderConfirmationToCustomer).not.toHaveBeenCalled();
  });

  it('fresh sale (normal path): sends both emails exactly once and fires the abandoned-checkout cancellation', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      emailOrderSelect: { data: unclaimedOrderRow, error: null },
      studioClaim: { data: [{ id: 'o1' }], error: null },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(emailNewOrderToStudio).toHaveBeenCalledTimes(1);
    expect(emailOrderConfirmationToCustomer).toHaveBeenCalledTimes(1);
    expect(sendPurchasedEvent).toHaveBeenCalledTimes(1);
  });

  it('under-fulfillment/failed path sends nothing', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 1, error: null }, // expected 1, fulfilled 0 → under-fulfilled
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(emailNewOrderToStudio).not.toHaveBeenCalled();
    expect(emailOrderConfirmationToCustomer).not.toHaveBeenCalled();
    expect(sendPurchasedEvent).not.toHaveBeenCalled();
  });
});
