import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

// --- Stripe: constructEventAsync (all paths) + refunds.create (under-fulfillment) ---
const constructEventAsync = vi.fn();
const refundsCreate = vi.fn(async () => ({}));
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ webhooks: { constructEventAsync }, refunds: { create: refundsCreate } }),
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
vi.mock('@/server/fulfilment/cancel-print', () => ({ cancelPrintFulfilment: vi.fn() }));
vi.mock('@/server/fulfilment/enqueue', () => ({ enqueueProdigi: vi.fn() }));

import { POST } from './route';
import { cancelPrintFulfilment } from '@/server/fulfilment/cancel-print';
import { enqueueProdigi } from '@/server/fulfilment/enqueue';
import { createOrderInvoice } from '@/lib/invoice';
import { createOrderShipment } from '@/lib/shipment';
import { emailNewOrderToStudio, emailOrderConfirmationToCustomer } from '@/lib/email';
import { sendPurchasedEvent } from '@/lib/resend-events';

type Result = { data: unknown; error: unknown };

/** A chainable query stub whose `.eq()`/`.in()` return itself and whose terminal method resolves `result`. */
function chain(terminal: 'select' | 'maybeSingle', result: Result, onCall?: (method: string, args: unknown[]) => void) {
  const b: Record<string, unknown> = {
    eq: (...args: unknown[]) => { onCall?.('eq', args); return b; },
    in: (...args: unknown[]) => { onCall?.('in', args); return b; },
  };
  b[terminal] = async () => result;
  return b;
}

/**
 * Supabase fake. `ordersUpdate` results are consumed per orders-UPDATE call
 * (releaseSale runs the pending→refunded CAS before the paid→refunded CAS);
 * a single value repeats for every call. `ordersSelect` is the fallback fetch
 * (releaseHold's failed-order lookup / releaseSale's refunded-order lookup);
 * `pieceUpdate` is the piece_state release. Records the piece_state update
 * payload and its `.eq()`/`.in()` filter calls so tests can assert the release
 * actually ran (and with the right target status + scoping).
 */
function makeSupabase(plan: { ordersUpdate: Result | Result[]; ordersSelect: Result; pieceUpdate: Result }) {
  const ordersUpdates = Array.isArray(plan.ordersUpdate) ? [...plan.ordersUpdate] : [plan.ordersUpdate];
  const calls = {
    pieceUpdatePayload: undefined as unknown,
    pieceUpdated: false,
    pieceFilters: [] as Array<{ method: string; args: unknown[] }>,
  };
  const supabase = {
    from(table: string) {
      if (table === 'orders') {
        return {
          update: () =>
            chain('select', ordersUpdates.length > 1 ? (ordersUpdates.shift() as Result) : ordersUpdates[0]),
          select: () => chain('maybeSingle', plan.ordersSelect),
        };
      }
      if (table === 'piece_state') {
        return {
          update: (payload: unknown) => {
            calls.pieceUpdatePayload = payload;
            calls.pieceUpdated = true;
            return chain('select', plan.pieceUpdate, (method, args) => calls.pieceFilters.push({ method, args }));
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

function disputeClosedEventRequest(status: string) {
  constructEventAsync.mockResolvedValue({
    type: 'charge.dispute.closed',
    data: { object: { status, payment_intent: 'pi_1' } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

describe('webhook releaseSale → cancelPrintFulfilment (Finding 1)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(cancelPrintFulfilment).mockClear();
  });

  const casFlipped = () =>
    makeSupabase({
      // update #1 = pending→refunded CAS (miss), update #2 = paid→refunded CAS (flip)
      ordersUpdate: [
        { data: [], error: null },
        { data: [{ id: 'o1', private_sale_id: null }], error: null },
      ],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [], error: null },
    });

  it('full refund: paid→refunded CAS flips and Prodigi cancel-or-alert runs for the order', async () => {
    supabaseImpl = casFlipped().supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(cancelPrintFulfilment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cancelPrintFulfilment).mock.calls[0][0]).toBe('o1');
  });

  it('replayed charge.refunded (already refunded, CAS misses): does NOT re-run the Prodigi handling', async () => {
    const { supabase } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('partial refund: releaseSale never runs, no Prodigi handling', async () => {
    supabaseImpl = casFlipped().supabase;

    const res = await POST(refundedEventRequest({ amount_refunded: 50 }));

    expect(res.status).toBe(200);
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('lost dispute: same handling as a full refund', async () => {
    supabaseImpl = casFlipped().supabase;

    const res = await POST(disputeClosedEventRequest('lost'));

    expect(res.status).toBe(200);
    expect(cancelPrintFulfilment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cancelPrintFulfilment).mock.calls[0][0]).toBe('o1');
  });

  it('won dispute: no release, no Prodigi handling', async () => {
    supabaseImpl = casFlipped().supabase;

    const res = await POST(disputeClosedEventRequest('won'));

    expect(res.status).toBe(200);
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
  });
});

describe('webhook releaseSale convergence + crash-resume (stage-one audit)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(cancelPrintFulfilment).mockClear();
  });

  it('refund delivered before succeeded (order still pending): parks the order refunded and frees the reserved hold', async () => {
    const { supabase, calls } = makeSupabase({
      // update #1 = pending→refunded CAS flips; the paid CAS is never consulted
      ordersUpdate: [{ data: [{ id: 'o1', private_sale_id: null }], error: null }],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    // releaseReservedPieces freed the reserved hold and relisted it
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
    // fulfilment never enqueues for a never-paid order — nothing to cancel
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('lost dispute before succeeded: same parking behaviour as a refund', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: [{ data: [{ id: 'o1', private_sale_id: null }], error: null }],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(disputeClosedEventRequest('lost'));

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(true);
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('retry after a crash between the refunded-CAS and the relist: finishes the relist (no permanently stuck sold pieces)', async () => {
    const { supabase, calls } = makeSupabase({
      // both CAS attempts miss — the order is already refunded
      ordersUpdate: { data: [], error: null },
      // the refunded-order fallback fetch finds it
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    // Without the fallback, the retry would return false here and the pieces
    // would stay 'sold' on a refunded order forever.
    expect(calls.pieceUpdated).toBe(true);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
  });

  it('private-sale crash-resume/replay: converges stranded reserved pieces to sold, never relists publicly (leak guard)', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: { id: 'o1', private_sale_id: 'ps_1' }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    // Private-sale resume may only ever write 'sold' (scoped to stranded
    // 'reserved' rows) — never 'available', which would relist publicly.
    expect(calls.pieceUpdated).toBe(true);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'sold', reserved_until: null, order_id: null });
    // The scoping IS the guard: widening to ['sold', 'reserved'] would stamp
    // order_id: null onto already-sold rows on every replay (provenance loss).
    expect(calls.pieceFilters).toEqual([
      { method: 'eq', args: ['order_id', 'o1'] },
      { method: 'in', args: ['status', ['reserved']] },
    ]);
  });

  it('private-sale refund before succeeded: frees the reserved hold back to sold (never available)', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: [{ data: [{ id: 'o1', private_sale_id: 'ps_1' }], error: null }],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'sold', reserved_until: null, order_id: null });
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
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
  // Claim UPDATEs recorded for assertion: the payload value written to the
  // *_sent_at column (a timestamp = claim, null = release) plus every chained
  // filter call, so tests can prove the atomic `.is(col, null)` guard is used.
  const studioClaimWrites: Array<{ value: unknown; filters: Array<[string, unknown[]]> }> = [];
  const confirmClaimWrites: Array<{ value: unknown; filters: Array<[string, unknown[]]> }> = [];
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
              const write = { value: payload.studio_email_sent_at, filters: [] as Array<[string, unknown[]]> };
              studioClaimWrites.push(write);
              return proxyChain(
                payload.studio_email_sent_at === null ? { data: [], error: null } : opts.studioClaim ?? { data: [], error: null },
                (method, args) => write.filters.push([method, args]),
              );
            }
            if ('confirmation_email_sent_at' in payload) {
              const write = { value: payload.confirmation_email_sent_at, filters: [] as Array<[string, unknown[]]> };
              confirmClaimWrites.push(write);
              return proxyChain(
                payload.confirmation_email_sent_at === null ? { data: [], error: null } : opts.confirmClaim ?? { data: [], error: null },
                (method, args) => write.filters.push([method, args]),
              );
            }
            throw new Error(`unexpected orders.update payload: ${JSON.stringify(payload)}`);
          },
          select: (columns: string) => {
            if (columns === 'id, status, private_sale_id') return proxyChain(opts.fallbackSelect ?? { data: null, error: null });
            if (columns === 'id, status') return proxyChain(opts.shipmentLookup);
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
  return { supabase, failedUpdateEqArgs, studioClaimWrites, confirmClaimWrites };
}

describe('webhook markPaid unknown payment_intent (F9b)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(createOrderShipment).mockClear();
  });

  it('unknown payment_intent (no orders row anywhere): logs + Sentry, createShipment lookup no-ops → 200, no shipment, no retry loop', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const zeroRows = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      // .single() finding no row surfaces as PostgREST's zero-rows error, not a bare null
      fallbackSelect: { data: null, error: zeroRows },
      shipmentLookup: { data: null, error: zeroRows },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    // 200, NOT a throw: an unknown payment_intent can never be fixed by a
    // Stripe redelivery, so the route must stop the retry loop (Sentry has
    // the alert). createShipment's own zero-rows lookup returns instead of
    // throwing, and no shipment is ever attempted.
    expect(res.status).toBe(200);
    expect(createOrderShipment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('markPaid: no order found for payment_intent', 'pi_1');
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_unknown_payment_intent');
    consoleErrorSpy.mockRestore();
  });

  it('a transient DB error on the fallback fetch throws from markPaid itself (5xx → Stripe retry), never reaching createShipment', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbError = { code: 'XX000', message: 'db hiccup' };
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: null, error: dbError },
      shipmentLookup: { data: null, error: dbError },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    // Unlike the unknown-PI case, a lookup failure IS retryable — the order's
    // real state is unknown, so nothing downstream may run against it.
    await expect(POST(succeededEventRequest())).rejects.toThrow(/markPaid: order lookup failed/);

    expect(createOrderShipment).not.toHaveBeenCalled();
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
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase, failedUpdateEqArgs } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      // By the time createShipment looks the order up, this path has set it 'failed'.
      shipmentLookup: { data: { id: 'o1', status: 'failed' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 1, error: null }, // expected 1, fulfilled 0 → under-fulfilled
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(failedUpdateEqArgs).toContainEqual(['status', 'paid']);
    consoleErrorSpy.mockRestore();
  });

  it('skips fulfilment entirely for a non-paid order: no shipment, no Prodigi, still 200', async () => {
    vi.mocked(createOrderShipment).mockClear();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      // Under-fulfillment refunded the buyer and set the order 'failed' —
      // buying an InPost label for it would ship pieces the buyer was just
      // refunded for.
      shipmentLookup: { data: { id: 'o1', status: 'failed' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 1, error: null },
      // A ceramic line item — WOULD ship if the status guard were missing.
      variantRows: { data: [{ variant: null }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(createOrderShipment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'createShipment: skipping fulfilment for non-paid order', 'o1', 'failed',
    );
    consoleErrorSpy.mockRestore();
  });

  it('throws (5xx → Stripe retry) when the refund create fails, WITHOUT relisting pieces or marking the order failed', async () => {
    refundsCreate.mockRejectedValueOnce(new Error('stripe refunds down'));
    vi.mocked(Sentry.captureException).mockClear();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase, failedUpdateEqArgs } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 1, error: null }, // under-fulfilled → refund path
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    // A paid customer must never lose their refund while pieces go back on
    // sale: the failed-status write (and the piece release before it) may only
    // run once the refund exists. Everything in the path is idempotent, so the
    // Stripe redelivery resumes at the refund.
    await expect(POST(succeededEventRequest())).rejects.toThrow(/stripe refunds down/);
    expect(failedUpdateEqArgs).toEqual([]);
    expect(Sentry.captureException).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
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
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
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

describe('webhook createShipment fulfilment routing (Finding 11)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(createOrderShipment).mockClear();
    vi.mocked(enqueueProdigi).mockClear();
  });

  const paidOrder = (variantRows: unknown[]) =>
    makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 0, error: null },
      variantRows: { data: variantRows, error: null },
    });

  it('ceramic line items → InPost shipment, no Prodigi enqueue', async () => {
    supabaseImpl = paidOrder([{ variant: null }]).supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(createOrderShipment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createOrderShipment).mock.calls[0][0]).toBe('pi_1');
    expect(enqueueProdigi).not.toHaveBeenCalled();
  });

  it('print line items → Prodigi enqueue, no InPost shipment', async () => {
    supabaseImpl = paidOrder([{ variant: { size: '50x70', framed: true } }]).supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(enqueueProdigi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueProdigi).mock.calls[0][0]).toBe('o1');
    expect(createOrderShipment).not.toHaveBeenCalled();
  });

  it('defensive mixed order → BOTH pipelines fire (Prodigi pulls only print items itself)', async () => {
    supabaseImpl = paidOrder([
      { variant: null },
      { variant: { size: '50x70', framed: true } },
    ]).supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(enqueueProdigi).toHaveBeenCalledTimes(1);
    expect(createOrderShipment).toHaveBeenCalledTimes(1);
  });
});

describe('webhook email idempotency on retry (F1)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    // Reset (not just clear): the claim-release test installs a rejecting impl.
    vi.mocked(emailNewOrderToStudio).mockReset();
    vi.mocked(emailOrderConfirmationToCustomer).mockReset();
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
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
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
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
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
    const { supabase, studioClaimWrites, confirmClaimWrites } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
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
    // The claim must be ATOMIC: a plain update without the `.is(col, null)`
    // filter would let two overlapping redeliveries both claim and both send.
    expect(studioClaimWrites).toHaveLength(1);
    expect(studioClaimWrites[0].filters).toContainEqual(['is', ['studio_email_sent_at', null]]);
    expect(confirmClaimWrites).toHaveLength(1);
    expect(confirmClaimWrites[0].filters).toContainEqual(['is', ['confirmation_email_sent_at', null]]);
  });

  it('releases the *_sent_at claim (CAS back to null on our own timestamp) when all 3 send attempts fail, so a replay can retry', async () => {
    vi.mocked(emailNewOrderToStudio).mockRejectedValue(new Error('resend down'));
    vi.mocked(emailOrderConfirmationToCustomer).mockRejectedValue(new Error('resend down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase, studioClaimWrites, confirmClaimWrites } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      emailOrderSelect: { data: unclaimedOrderRow, error: null },
      studioClaim: { data: [{ id: 'o1' }], error: null },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    // Fake timers: the route's retry backoff sleeps 200+400ms per email —
    // don't pay ~1.2s of real wall-clock in a unit test.
    vi.useFakeTimers();
    let res!: Response;
    try {
      const resPromise = POST(succeededEventRequest());
      await vi.runAllTimersAsync();
      res = await resPromise;
    } finally {
      vi.useRealTimers();
    }

    // Still 200 (the email is best-effort), but the claim is handed back:
    // write #1 claims with a timestamp, write #2 resets to null CAS'd on that
    // exact timestamp — so a later redelivery/manual replay retries the send
    // instead of finding a permanently-claimed column for a never-sent email.
    expect(res.status).toBe(200);
    for (const [writes, col] of [
      [studioClaimWrites, 'studio_email_sent_at'],
      [confirmClaimWrites, 'confirmation_email_sent_at'],
    ] as const) {
      expect(writes).toHaveLength(2);
      expect(typeof writes[0].value).toBe('string');
      expect(writes[1].value).toBeNull();
      expect(writes[1].filters).toContainEqual(['eq', [col, writes[0].value]]);
    }
    expect(emailNewOrderToStudio).toHaveBeenCalledTimes(3);
    expect(emailOrderConfirmationToCustomer).toHaveBeenCalledTimes(3);
    consoleErrorSpy.mockRestore();
  });

  it('print order: studio email carries variant + Prodigi SKU, confirmation uses print copy', async () => {
    const printVariant = { size: '50x70', framed: true, mount: false, frameColour: 'black' };
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 0, error: null }, // print-only: 0 expected ceramics = fulfilled
      variantRows: { data: [{ product_id: 'fap01', unit_price: 42000, variant: printVariant }], error: null },
      emailOrderSelect: { data: { ...unclaimedOrderRow, delivery_method: 'kurier', inpost_target_point: null }, error: null },
      studioClaim: { data: [{ id: 'o1' }], error: null },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(emailNewOrderToStudio).toHaveBeenCalledTimes(1);
    const studioPayload = vi.mocked(emailNewOrderToStudio).mock.calls[0][0] as {
      order: { items: Array<{ variant: { prodigiSku: string } | null }> };
    };
    expect(studioPayload.order.items[0].variant).toMatchObject({
      ...printVariant,
      prodigiSku: 'GLOBAL-CFP-20X28',
    });
    expect(emailOrderConfirmationToCustomer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emailOrderConfirmationToCustomer).mock.calls[0][0]).toMatchObject({ kind: 'print' });
  });

  it('ceramic order: confirmation stays on ceramic copy, studio items carry variant null', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [{ product_id: 'k01', unit_price: 10000, variant: null }], error: null },
      emailOrderSelect: { data: unclaimedOrderRow, error: null },
      studioClaim: { data: [{ id: 'o1' }], error: null },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    const studioPayload = vi.mocked(emailNewOrderToStudio).mock.calls[0][0] as {
      order: { items: Array<{ variant: unknown }> };
    };
    expect(studioPayload.order.items[0].variant).toBeNull();
    expect(vi.mocked(emailOrderConfirmationToCustomer).mock.calls[0][0]).toMatchObject({ kind: 'ceramic' });
  });

  it('under-fulfillment/failed path sends nothing', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'failed' }, error: null },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 1, error: null }, // expected 1, fulfilled 0 → under-fulfilled
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());
    consoleErrorSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(emailNewOrderToStudio).not.toHaveBeenCalled();
    expect(emailOrderConfirmationToCustomer).not.toHaveBeenCalled();
    expect(sendPurchasedEvent).not.toHaveBeenCalled();
  });
});
