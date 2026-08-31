import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

// --- Stripe: constructEventAsync (all paths) + refunds.create (under-fulfillment) ---
const constructEventAsync = vi.fn();
const refundsCreate = vi.fn(async () => ({}));
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ webhooks: { constructEventAsync }, refunds: { create: refundsCreate } }),
}));

// --- Cloudflare env: mutable per-test so specific describe blocks can opt into
// conversion credentials (GA4/Meta) without affecting the rest of the suite,
// which relies on trackPurchase no-op'ing with no creds configured. ---
let cfEnv: Record<string, string | undefined> = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
// Conversion sends are deferred via ctx.waitUntil, so the fake collects the
// promises instead of dropping them: tests still assert the send was *invoked*
// synchronously (waitUntil receives an already-started promise), and
// `settleDeferred()` lets a test await completion when it needs the effects.
let deferred: Promise<unknown>[] = [];
const settleDeferred = () => Promise.all(deferred);
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: cfEnv,
    ctx: { waitUntil: (p: Promise<unknown>) => deferred.push(Promise.resolve(p).catch(() => {})) },
  }),
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
vi.mock('@/lib/email', () => ({
  emailNewOrderToStudio: vi.fn(),
  emailOrderConfirmationToCustomer: vi.fn(),
  emailRefundFailedAlertToStudio: vi.fn(async () => {}),
  emailPrivateSaleDoublePaidAlertToStudio: vi.fn(async () => {}),
  emailDisputeCreatedAlertToStudio: vi.fn(async () => {}),
  emailInvoiceFailedAlertToStudio: vi.fn(async () => {}),
}));
vi.mock('@/lib/resend-events', () => ({ sendPurchasedEvent: vi.fn() }));
// Both are `async` in the real module and are now handed to ctx.waitUntil with a
// trailing .catch, so the fakes must resolve a promise rather than return undefined.
vi.mock('@/lib/marketing/conversions', () => ({
  sendPurchaseConversions: vi.fn(async () => {}),
  sendRefundConversion: vi.fn(async () => {}),
}));
vi.mock('@/server/fulfilment/cancel-print', () => ({ cancelPrintFulfilment: vi.fn() }));
vi.mock('@/server/fulfilment/enqueue', () => ({ enqueueProdigi: vi.fn() }));

import { POST } from './route';
import { cancelPrintFulfilment } from '@/server/fulfilment/cancel-print';
import { enqueueProdigi } from '@/server/fulfilment/enqueue';
import { createOrderInvoice } from '@/lib/invoice';
import { createOrderShipment } from '@/lib/shipment';
import { emailNewOrderToStudio, emailOrderConfirmationToCustomer, emailPrivateSaleDoublePaidAlertToStudio, emailDisputeCreatedAlertToStudio, emailInvoiceFailedAlertToStudio } from '@/lib/email';
import { sendPurchasedEvent } from '@/lib/resend-events';
import { sendPurchaseConversions, sendRefundConversion } from '@/lib/marketing/conversions';

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

// --- webhook_events idempotency ledger fake (F-18) ---------------------------
type WebhookEventsPlan = {
  /** initial `.select().eq().eq().maybeSingle()` — default fresh (no row). */
  seen?: QueryResult;
  /** the re-SELECT after an insert-`23505` race (M-22) — defaults to `seen`. */
  seenAfterInsert?: QueryResult;
  /** `.insert()` result — default success. */
  insert?: QueryResult;
  /** stale-lease reclaim `.update()…select('id').maybeSingle()` — default reclaimed. */
  claimCas?: QueryResult;
  /** completion `.update({status:'done'}).eq().eq().eq()` — default success. */
  done?: QueryResult;
  /** records every `.update()` payload (assert lease release on throw). */
  updates?: Array<Record<string, unknown>>;
  /** records every `.update()` payload + its chained filters (L-4 claim scoping). */
  updateCalls?: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown[]]> }>;
  /** records `.insert()` payloads (recover the claimedAt lease token). */
  inserts?: Array<Record<string, unknown>>;
};

/** Chain node for the webhook_events fake: `.eq()`/`.is()` return self,
 *  `.select().maybeSingle()` and `.maybeSingle()` resolve `result`, and the node
 *  is itself awaitable (the done-write awaits `.eq().eq().eq()` directly). */
function weChain(result: QueryResult, onFilter?: (method: string, args: unknown[]) => void): Record<string, unknown> {
  const node: Record<string, unknown> = {
    eq: (...args: unknown[]) => { onFilter?.('eq', args); return node; },
    is: (...args: unknown[]) => { onFilter?.('is', args); return node; },
    select: () => ({ maybeSingle: async () => result }),
    maybeSingle: async () => result,
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return node;
}

/**
 * webhook_events idempotency-ledger fake (F-18). Default = a *fresh* event that
 * inserts and marks done cleanly, so the Stripe claim wrapper is transparent to
 * every pre-existing test. Override to exercise dedup: `seen` a done/processing
 * row, or make `done` an error. CAS vs done UPDATE are told apart by payload
 * status (`processing` = stale-lease reclaim, `done`/`failed` = completion or
 * lease release). The second `.select()` (the post-insert-race re-read) serves
 * `seenAfterInsert` when provided.
 */
function webhookEventsTable(plan: WebhookEventsPlan = {}) {
  const seen = plan.seen ?? { data: null, error: null };
  const insert = plan.insert ?? { error: null };
  const claimCas = plan.claimCas ?? { data: { id: 'we_1' }, error: null };
  const done = plan.done ?? { error: null };
  let selects = 0;
  return {
    select: () => {
      selects += 1;
      return weChain(selects === 1 ? seen : plan.seenAfterInsert ?? seen);
    },
    insert: async (payload: Record<string, unknown>) => {
      plan.inserts?.push(payload);
      return insert;
    },
    update: (payload: Record<string, unknown>) => {
      plan.updates?.push(payload);
      const call = { payload, filters: [] as Array<[string, unknown[]]> };
      plan.updateCalls?.push(call);
      return weChain(payload.status === 'processing' ? claimCas : done, (method, args) => call.filters.push([method, args]));
    },
  };
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
function makeSupabase(plan: { ordersUpdate: Result | Result[]; ordersSelect: Result; pieceUpdate: Result; webhookEvents?: WebhookEventsPlan; rpc?: Result | ((fn: string, params: Record<string, unknown>) => Result) }) {
  const ordersUpdates = Array.isArray(plan.ordersUpdate) ? [...plan.ordersUpdate] : [plan.ordersUpdate];
  // One ledger instance per fake — its select counter (seen vs seenAfterInsert)
  // must survive across `.from()` calls.
  const webhookEvents = webhookEventsTable(plan.webhookEvents);
  const calls = {
    pieceUpdatePayload: undefined as unknown,
    pieceUpdated: false,
    pieceFilters: [] as Array<{ method: string; args: unknown[] }>,
    ordersUpdatePayloads: [] as Array<Record<string, unknown>>,
    rpcCalls: [] as Array<{ fn: string; params: Record<string, unknown> }>,
  };
  const supabase = {
    rpc: async (fn: string, params: Record<string, unknown>) => {
      calls.rpcCalls.push({ fn, params });
      return typeof plan.rpc === 'function' ? plan.rpc(fn, params) : plan.rpc ?? { data: true, error: null };
    },
    from(table: string) {
      if (table === 'orders') {
        return {
          update: (payload: Record<string, unknown>) => {
            calls.ordersUpdatePayloads.push(payload);
            return chain('select', ordersUpdates.length > 1 ? (ordersUpdates.shift() as Result) : ordersUpdates[0]);
          },
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
      if (table === 'webhook_events') return webhookEvents;
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

function canceledEventRequest() {
  constructEventAsync.mockResolvedValue({
    type: 'payment_intent.canceled',
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

    const res = await POST(canceledEventRequest());

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

    const res = await POST(canceledEventRequest());

    expect(res.status).toBe(200);
    // Without the retry-safe fallback the release would be skipped and pieces stay reserved.
    expect(calls.pieceUpdated).toBe(true);
  });
});

describe('webhook payment_intent.payment_failed', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('is a no-op: a failed attempt does not release the hold (per-attempt event, not terminal)', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(false);
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

describe('webhook releaseSale GA4 refund conversion (F-08)', () => {
  const marketing = {
    consent: 'granted', ga_client_id: '111.222', ga_session_id: '999',
    fbp: null, fbc: null, ip: null, user_agent: null, event_source_url: null,
    captured_at: '2026-06-09T00:00:00Z',
  };

  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(sendRefundConversion).mockClear();
    deferred = [];
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
  });
  afterEach(() => {
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  });

  it('paid→refunded transition: sends a GA4 refund event when consent was granted', async () => {
    const { supabase } = makeSupabase({
      ordersUpdate: [
        { data: [], error: null }, // pending→refunded CAS: no match (order was paid)
        {
          data: [{
            id: 'o1',
            private_sale_id: null,
            subtotal: 30000,
            shipping: 1800,
            currency: 'pln',
            marketing,
          }], error: null,
        }, // paid→refunded CAS: matches
      ],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(sendRefundConversion).toHaveBeenCalledWith(
      { payment_intent_id: 'pi_1', subtotal: 30000, shipping: 1800, currency: 'pln', marketing },
      { ga4Config: { measurementId: 'G-TEST', apiSecret: 'ga4_secret_test' } },
    );
  });

  it('pending→refunded (refund before succeeded): no refund event — no purchase revenue was ever recorded', async () => {
    const { supabase } = makeSupabase({
      ordersUpdate: [{ data: [{ id: 'o1', private_sale_id: null }], error: null }],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(sendRefundConversion).not.toHaveBeenCalled();
  });

  it('replayed charge.refunded (already refunded, both CAS miss): does not re-fire the reversal', async () => {
    const { supabase } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(sendRefundConversion).not.toHaveBeenCalled();
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
    // The pending→refunded CAS clears the M-5 marker/lease as it goes terminal:
    // a charge.refunded racing the double-paid window must not leave
    // refund_pending_at set forever on a refunded row.
    expect(calls.ordersUpdatePayloads[0]).toEqual({ status: 'refunded', refund_pending_at: null, expiry_claim_at: null });
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
  /** Result of the reserved→sold piece_state UPDATE (H-1). Defaults to success. */
  pieceSoldUpdate?: QueryResult;
  /** M-5: result of the `refund_pending_at` marker CAS (no `status` in payload). */
  markerClaim?: QueryResult;
  /** M-5: result of the `{ status: 'failed', refund_pending_at: null }` CAS. */
  doublePaidCas?: QueryResult;
  soldCount?: QueryResult;
  ceramicCount?: QueryResult;
  variantRows?: QueryResult;
  /** The `id, email, ... , confirmation_email_sent_at, studio_email_sent_at` load. */
  emailOrderSelect?: QueryResult;
  /** Result of the atomic `studio_email_sent_at IS NULL` claim UPDATE. */
  studioClaim?: QueryResult;
  /** Result of the atomic `confirmation_email_sent_at IS NULL` claim UPDATE. */
  confirmClaim?: QueryResult;
  /** Result of a `*_sent_at` claim RELEASE write (payload value null) — default success (L-7). */
  claimRelease?: QueryResult;
  /** Make the conversions-claim UPDATE throw synchronously (L-7 outer-catch test). */
  conversionsClaimThrows?: boolean;
  /** The conversions `loadOrder` select (`id, payment_intent_id, status, subtotal, ...`). */
  conversionsOrderSelect?: QueryResult;
  /**
   * Result of the atomic `conversions_sent_at IS NULL` claim UPDATE. Defaults to
   * "claim won" so tests that only care about downstream conversions behaviour
   * don't each have to opt in; the redelivery case sets an empty array explicitly.
   */
  conversionsClaim?: QueryResult;
  /** F-18 idempotency ledger override; default = fresh event (transparent). */
  webhookEvents?: WebhookEventsPlan;
  /** RPC results (promo settle/claim). Default success (`data: true`). */
  rpc?: QueryResult | ((fn: string, params: Record<string, unknown>) => QueryResult);
  /** promo_codes lookup for the markPaid reconcile path. */
  promoCodesSelect?: QueryResult;
}) {
  const failedUpdateEqArgs: unknown[][] = [];
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  // Claim UPDATEs recorded for assertion: the payload value written to the
  // *_sent_at column (a timestamp = claim, null = release) plus every chained
  // filter call, so tests can prove the atomic `.is(col, null)` guard is used.
  const studioClaimWrites: Array<{ value: unknown; filters: Array<[string, unknown[]]> }> = [];
  const confirmClaimWrites: Array<{ value: unknown; filters: Array<[string, unknown[]]> }> = [];
  // One ledger instance per fake — its select counter (seen vs seenAfterInsert)
  // must survive across `.from()` calls.
  const webhookEvents = webhookEventsTable(opts.webhookEvents);
  // M-5: global operation sequence (marker CAS / final CAS / piece writes) —
  // tests append refund creation via a refundsCreate mockImplementation, so
  // ordering constraints (marker BEFORE refund) are assertable. Both CAS
  // writes also record their filter chains, so the `.eq('status','pending')`
  // predicates are pinned (not just the payload shape).
  const seq: string[] = [];
  const markerWrites: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown[]]> }> = [];
  const doublePaidWrites: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown[]]> }> = [];
  const pieceWrites: Array<Record<string, unknown>> = [];
  const supabase = {
    rpc: async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      return typeof opts.rpc === 'function' ? opts.rpc(fn, params) : opts.rpc ?? { data: true, error: null };
    },
    from(table: string) {
      if (table === 'promo_codes') {
        return { select: () => proxyChain(opts.promoCodesSelect ?? { data: null, error: null }) };
      }
      if (table === 'orders') {
        return {
          update: (payload: Record<string, unknown>) => {
            if (payload.status === 'paid') return proxyChain(opts.casUpdate);
            if (payload.status === 'failed' && 'refund_pending_at' in payload) {
              seq.push('double_paid_cas');
              const write = { payload, filters: [] as Array<[string, unknown[]]> };
              doublePaidWrites.push(write);
              return proxyChain(
                opts.doublePaidCas ?? { data: [{ id: 'o1' }], error: null },
                (method, args) => write.filters.push([method, args]),
              );
            }
            if (payload.status === 'failed') {
              return proxyChain({ data: null, error: null }, (method, args) => {
                if (method === 'eq') failedUpdateEqArgs.push(args);
              });
            }
            if ('refund_pending_at' in payload) {
              seq.push('marker');
              const write = { payload, filters: [] as Array<[string, unknown[]]> };
              markerWrites.push(write);
              return proxyChain(
                opts.markerClaim ?? { data: [{ id: 'o1', private_sale_id: 'ps_1' }], error: null },
                (method, args) => write.filters.push([method, args]),
              );
            }
            if ('studio_email_sent_at' in payload) {
              const write = { value: payload.studio_email_sent_at, filters: [] as Array<[string, unknown[]]> };
              studioClaimWrites.push(write);
              return proxyChain(
                payload.studio_email_sent_at === null
                  ? opts.claimRelease ?? { data: [], error: null }
                  : opts.studioClaim ?? { data: [], error: null },
                (method, args) => write.filters.push([method, args]),
              );
            }
            if ('confirmation_email_sent_at' in payload) {
              const write = { value: payload.confirmation_email_sent_at, filters: [] as Array<[string, unknown[]]> };
              confirmClaimWrites.push(write);
              return proxyChain(
                payload.confirmation_email_sent_at === null
                  ? opts.claimRelease ?? { data: [], error: null }
                  : opts.confirmClaim ?? { data: [], error: null },
                (method, args) => write.filters.push([method, args]),
              );
            }
            if ('conversions_sent_at' in payload) {
              if (opts.conversionsClaimThrows) throw new Error('conversions claim blew up');
              return proxyChain(opts.conversionsClaim ?? { data: [{ id: 'o1' }], error: null });
            }
            throw new Error(`unexpected orders.update payload: ${JSON.stringify(payload)}`);
          },
          select: (columns: string) => {
            if (columns === 'id, status, private_sale_id, promo_code') return proxyChain(opts.fallbackSelect ?? { data: null, error: null });
            if (columns === 'id, status') return proxyChain(opts.shipmentLookup);
            if (columns.startsWith('id, email')) return proxyChain(opts.emailOrderSelect ?? { data: null, error: null });
            if (columns.startsWith('id, payment_intent_id')) return proxyChain(opts.conversionsOrderSelect ?? { data: null, error: null });
            throw new Error(`unexpected orders.select columns: ${columns}`);
          },
        };
      }
      if (table === 'piece_state') {
        return {
          update: (payload: Record<string, unknown>) => {
            seq.push('piece_update');
            pieceWrites.push(payload);
            return proxyChain(opts.pieceSoldUpdate ?? { data: null, error: null });
          },
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
      if (table === 'webhook_events') return webhookEvents;
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { supabase, failedUpdateEqArgs, studioClaimWrites, confirmClaimWrites, seq, markerWrites, doublePaidWrites, pieceWrites, rpcCalls };
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

describe('webhook trackPurchase loadOrder failure alert (F-06)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(sendPurchaseConversions).mockClear();
    deferred = [];
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
  });
  afterEach(() => {
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  });

  it('a transient error loading the order for conversions is alerted, not silently dropped', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Exercise the real loadOrder closure route.ts builds and passes as a dep,
    // without needing the real sendPurchaseConversions (and its Meta/GA4 HTTP
    // calls) — mirrors how ConversionsDeps.loadOrder is designed to be injected.
    vi.mocked(sendPurchaseConversions).mockImplementationOnce(async (pi, deps) => {
      await deps.loadOrder(pi);
    });
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsClaim: { data: [{ id: 'o1' }], error: null },
      conversionsOrderSelect: { data: null, error: { code: '500', message: 'connection reset' } },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());
    // The send is deferred via ctx.waitUntil, so the alert lands after the 200.
    await settleDeferred();

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('conversions_load_order_failed', {
      level: 'warning',
      extra: { payment_intent_id: 'pi_1', error: 'connection reset' },
    });
    consoleErrorSpy.mockRestore();
  });
});

describe('webhook trackPurchase conversions claim (F-05)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(sendPurchaseConversions).mockClear();
    deferred = [];
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
  });
  afterEach(() => {
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  });

  it('first delivery: claims conversions_sent_at and sends', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(sendPurchaseConversions).toHaveBeenCalledTimes(1);
  });

  it('redelivery after conversions already claimed: does not send again', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsClaim: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(sendPurchaseConversions).not.toHaveBeenCalled();
  });

  it('the send is deferred via waitUntil: a slow Meta/GA4 call does not hold the webhook 200', async () => {
    let releaseSend: () => void = () => {};
    vi.mocked(sendPurchaseConversions).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSend = resolve; }),
    );
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    // Resolves even though the conversion send is still in flight — that's the
    // point of the deferral. Awaited inline, this test would hang forever.
    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(sendPurchaseConversions).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);
    releaseSend();
    await settleDeferred();
  });

  it('a failed claim UPDATE does not send (and does not throw the webhook off its 200)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsClaim: { data: null, error: { message: 'db down' } },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(sendPurchaseConversions).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('webhook markPaid succeeded-on-dead-order alert (F-01)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(createOrderShipment).mockClear();
  });

  it('succeeded lands on an already-failed order: alerts via Sentry, does not fulfil, does not throw', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'failed', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'failed' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(createOrderShipment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('markPaid: succeeded on a dead order', 'pi_1', 'o1', 'failed');
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_succeeded_on_dead_order', {
      level: 'error',
      extra: { payment_intent_id: 'pi_1', order_id: 'o1', order_status: 'failed' },
    });
    consoleErrorSpy.mockRestore();
  });

  it('succeeded lands on an already-expired order: alerts via Sentry', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'expired', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'expired' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_succeeded_on_dead_order', {
      level: 'error',
      extra: { payment_intent_id: 'pi_1', order_id: 'o1', order_status: 'expired' },
    });
    consoleErrorSpy.mockRestore();
  });

  it("succeeded lands on an already-refunded order: no alert (releaseSale's documented race)", async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'refunded', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'refunded' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith('stripe_webhook_succeeded_on_dead_order', expect.anything());
  });
});

describe('webhook markPaid reserved→sold update failure (H-1)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    refundsCreate.mockClear();
  });

  it('throws (5xx → Stripe retry) when the sold-UPDATE errors — never auto-refunds off the asymmetric COUNT', async () => {
    const { supabase, failedUpdateEqArgs } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      // The sold-UPDATE fails, but the follow-up COUNT succeeds at 0 sold rows:
      // without the error check this reads as under-fulfilment and auto-refunds
      // a legitimate payment (H-1). It must throw instead so Stripe retries.
      pieceSoldUpdate: { data: null, error: { message: 'transient db failure' } },
      soldCount: { count: 0, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/piece_state sold update failed/);
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(failedUpdateEqArgs).toEqual([]);
  });
});

describe('webhook charge.dispute.created alert (L-6)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(emailDisputeCreatedAlertToStudio).mockClear();
  });

  function disputeCreatedRequest() {
    constructEventAsync.mockResolvedValue({
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_1',
          payment_intent: 'pi_1',
          status: 'needs_response',
          reason: 'fraudulent',
          amount: 13900,
          currency: 'pln',
          evidence_details: { due_by: 1767139200 }, // 2025-12-31T00:00:00Z
        },
      },
    });
    return new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: '{}',
    });
  }

  it('fires the deadline-bearing studio alert + Sentry, correlated to the order by payment_intent', async () => {
    const { supabase } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(disputeCreatedRequest());

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_dispute_created', expect.objectContaining({
      level: 'error',
      extra: expect.objectContaining({ dispute_id: 'dp_1', evidence_due_by: 1767139200, order_id: 'o1' }),
    }));
    expect(emailDisputeCreatedAlertToStudio).toHaveBeenCalledTimes(1);
    expect(emailDisputeCreatedAlertToStudio).toHaveBeenCalledWith({
      orderId: 'o1',
      disputeId: 'dp_1',
      amount: 13900,
      currency: 'pln',
      reason: 'fraudulent',
      evidenceDueBy: 1767139200,
    });
  });

  it('a failed alert send throws (5xx) so Stripe retries the delivery — a dispute alert must not be droppable', async () => {
    vi.mocked(emailDisputeCreatedAlertToStudio).mockRejectedValueOnce(new Error('resend down'));
    const { supabase } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [], error: null },
    });
    supabaseImpl = supabase;

    await expect(POST(disputeCreatedRequest())).rejects.toThrow(/resend down/);
  });
});

describe('webhook markPaid private-sale double-payment (M-5)', () => {
  // The pending→paid CAS violating private_sales_one_paid_order — Postgres
  // unique-violation code 23505 — is the double-paid signal.
  const uniqueViolation = {
    code: '23505',
    message: 'duplicate key value violates unique constraint "private_sales_one_paid_order"',
  };

  beforeEach(() => {
    constructEventAsync.mockReset();
    refundsCreate.mockReset();
    refundsCreate.mockResolvedValue({});
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(emailPrivateSaleDoublePaidAlertToStudio).mockClear();
  });

  const doublePaidOpts = () => ({
    casUpdate: { data: null, error: uniqueViolation },
    shipmentLookup: { data: { id: 'o1', status: 'failed' }, error: null },
    variantRows: { data: [], error: null },
  });

  it('(a) sets the refund_pending_at marker BEFORE refunds.create, which runs once with the shared refund key', async () => {
    const { supabase, seq, markerWrites } = makeSucceededSupabase(doublePaidOpts());
    refundsCreate.mockImplementation(async () => {
      seq.push('refund');
      return {};
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1' }, { idempotencyKey: 'refund_pi_1' });
    expect(markerWrites).toHaveLength(1);
    expect(typeof markerWrites[0].payload.refund_pending_at).toBe('string');
    // The marker CAS must be scoped — an unfiltered UPDATE would stamp every order.
    expect(markerWrites[0].filters).toContainEqual(['eq', ['payment_intent_id', 'pi_1']]);
    expect(markerWrites[0].filters).toContainEqual(['eq', ['status', 'pending']]);
    // The durable marker must exist before money moves — the crash-window guard.
    expect(seq.indexOf('marker')).toBeLessThan(seq.indexOf('refund'));
  });

  it('(b) terminal state: pending→failed CAS clears the marker, pieces converge to sold, 200 + Sentry + studio alert', async () => {
    const { supabase, doublePaidWrites, pieceWrites, seq } = makeSucceededSupabase(doublePaidOpts());
    vi.mocked(emailPrivateSaleDoublePaidAlertToStudio).mockImplementationOnce(async () => {
      seq.push('alert');
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(doublePaidWrites).toHaveLength(1);
    expect(doublePaidWrites[0].payload).toEqual({ status: 'failed', refund_pending_at: null });
    // The final CAS is scoped like the marker CAS.
    expect(doublePaidWrites[0].filters).toContainEqual(['eq', ['payment_intent_id', 'pi_1']]);
    expect(doublePaidWrites[0].filters).toContainEqual(['eq', ['status', 'pending']]);
    // Order B's still-reserved private-sale pieces must not strand `reserved`
    // (a lapsed reservation would leak into public reserve_pieces()) — they
    // converge to the private-sale terminal state before the final CAS.
    expect(pieceWrites).toContainEqual({ status: 'sold', reserved_until: null, order_id: null });
    expect(seq.indexOf('piece_update')).toBeLessThan(seq.indexOf('double_paid_cas'));
    expect(Sentry.captureMessage).toHaveBeenCalledWith('private_sale_double_paid', expect.objectContaining({ level: 'error' }));
    expect(emailPrivateSaleDoublePaidAlertToStudio).toHaveBeenCalledTimes(1);
    // Alert BEFORE the terminal CAS (an isolate death after the CAS would ack
    // without re-alerting), deduped across crash-retries by the Resend key.
    expect(seq.indexOf('alert')).toBeLessThan(seq.indexOf('double_paid_cas'));
    expect(vi.mocked(emailPrivateSaleDoublePaidAlertToStudio).mock.calls[0][0]).toMatchObject({
      idempotencyKey: 'double-paid-alert/o1',
    });
  });

  it('(d) a promo redemption on the double-paid order settles released, not left pending forever', async () => {
    const { supabase, rpcCalls } = makeSucceededSupabase({
      ...doublePaidOpts(),
      markerClaim: { data: [{ id: 'o1', private_sale_id: 'ps_1', promo_code: 'WELCOME10' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(rpcCalls).toContainEqual({
      fn: 'settle_promo_redemption',
      params: { p_order_id: 'o1', p_status: 'released' },
    });
  });

  it('(e) already-refunded error after idempotency-key expiry: treated as success, CAS still proceeds to failed', async () => {
    refundsCreate.mockRejectedValue({ code: 'charge_already_refunded', message: 'Charge ch_1 has already been refunded.' });
    const { supabase, doublePaidWrites } = makeSucceededSupabase(doublePaidOpts());
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(doublePaidWrites).toHaveLength(1);
    expect(doublePaidWrites[0].payload).toEqual({ status: 'failed', refund_pending_at: null });
  });

  it('(g3) zero-row final CAS with a follow-up lookup finding a safe terminal state: acks 200 (no retry loop on a benign convergence race)', async () => {
    const { supabase } = makeSucceededSupabase({
      ...doublePaidOpts(),
      doublePaidCas: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'failed', private_sale_id: 'ps_1' }, error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('private_sale_double_paid', expect.objectContaining({ level: 'error' }));
  });

  it('(f) zero-row marker CAS with the order already failed: NO refunds.create, ack 200', async () => {
    const { supabase } = makeSucceededSupabase({
      ...doublePaidOpts(),
      markerClaim: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'failed', private_sale_id: 'ps_1' }, error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it('(f2) zero-row marker CAS with the order already refunded: NO refunds.create, ack 200', async () => {
    const { supabase } = makeSucceededSupabase({
      ...doublePaidOpts(),
      markerClaim: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'refunded', private_sale_id: 'ps_1' }, error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it('(g) zero-row marker CAS with the order missing: throws (5xx → Stripe retry), never refunds a row it cannot account for', async () => {
    const { supabase } = makeSucceededSupabase({
      ...doublePaidOpts(),
      markerClaim: { data: [], error: null },
      fallbackSelect: { data: null, error: null },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/unexpected state/);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it('(g2) zero-row final CAS with a follow-up lookup finding an unexpected status: throws, not a silent 200', async () => {
    const { supabase } = makeSucceededSupabase({
      ...doublePaidOpts(),
      doublePaidCas: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: 'ps_1' }, error: null },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/unexpected state/);
    // The refund DID run (the marker claimed a genuinely-pending row) — only
    // the acknowledgement is withheld until the state converges.
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it('(h) a non-23505 error on the pending→paid CAS keeps the unconditional throw', async () => {
    const { supabase } = makeSucceededSupabase({
      ...doublePaidOpts(),
      casUpdate: { data: null, error: { code: 'XX000', message: 'db down' } },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/markPaid orders update failed: db down/);
    expect(refundsCreate).not.toHaveBeenCalled();
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

describe('webhook ensureInvoiced failure (F5 + L-5)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(emailInvoiceFailedAlertToStudio).mockClear();
  });

  const invoiceFailOpts = () => ({
    // "Already processed" retry path: CAS matches nothing, fallback finds the paid
    // order. emailOrderSelect is left unset (defaults to a null row) so the email
    // block no-ops, keeping this test isolated to ensureInvoiced.
    casUpdate: { data: [], error: null },
    fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
    shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
    soldCount: { count: 1, error: null },
    ceramicCount: { count: 1, error: null },
    variantRows: { data: [], error: null },
  });

  it('captures the exception in Sentry, fires the studio alert email (L-5), and the route still responds 200', async () => {
    vi.mocked(createOrderInvoice).mockRejectedValueOnce(new Error('invoice api down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase(invoiceFailOpts());
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(emailInvoiceFailedAlertToStudio).toHaveBeenCalledTimes(1);
    expect(emailInvoiceFailedAlertToStudio).toHaveBeenCalledWith({
      paymentIntentId: 'pi_1',
      errorMessage: 'invoice api down',
    });
    consoleErrorSpy.mockRestore();
  });

  it('a failing alert email is itself swallowed — Stripe must still get its 200 (invoicing is best-effort by design)', async () => {
    vi.mocked(createOrderInvoice).mockRejectedValueOnce(new Error('invoice api down'));
    vi.mocked(emailInvoiceFailedAlertToStudio).mockRejectedValueOnce(new Error('resend down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase(invoiceFailOpts());
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    consoleErrorSpy.mockRestore();
  });
});

describe('webhook markPaid post-processing silent catches upgraded to Sentry (L-7)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(emailNewOrderToStudio).mockReset();
    vi.mocked(emailOrderConfirmationToCustomer).mockReset();
  });

  const freshSaleOpts = () => ({
    casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
    shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
    soldCount: { count: 1, error: null },
    ceramicCount: { count: 1, error: null },
    variantRows: { data: [], error: null },
  });

  it('(1) the post-processing catch (order/items load for emails) reports to Sentry, still 200', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      ...freshSaleOpts(),
      emailOrderSelect: { data: null, error: { message: 'load blew up' } },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(Sentry.captureException).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('(2) an email-claim UPDATE failure alerts (the email is silently lost otherwise — the route 200s, so no redelivery)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unclaimed = {
      id: 'o1', email: 'buyer@example.com', total: 10000, currency: 'pln',
      delivery_method: 'paczkomat', receiver_first_name: 'Ann', receiver_last_name: 'K',
      inpost_target_point: 'WAW01', locale: 'pl',
      confirmation_email_sent_at: null, studio_email_sent_at: null,
    };
    const { supabase } = makeSucceededSupabase({
      ...freshSaleOpts(),
      emailOrderSelect: { data: unclaimed, error: null },
      studioClaim: { data: null, error: { message: 'claim db down' } },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(emailNewOrderToStudio).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith('email_claim_failed', expect.objectContaining({
      level: 'error',
      extra: expect.objectContaining({ order_id: 'o1', column: 'studio_email_sent_at' }),
    }));
    consoleErrorSpy.mockRestore();
  });

  it('(3) a claim-release failure after 3 failed sends alerts (the stuck claim blocks every future retry)', async () => {
    vi.mocked(emailNewOrderToStudio).mockRejectedValue(new Error('resend down'));
    vi.mocked(emailOrderConfirmationToCustomer).mockRejectedValue(new Error('resend down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unclaimed = {
      id: 'o1', email: 'buyer@example.com', total: 10000, currency: 'pln',
      delivery_method: 'paczkomat', receiver_first_name: 'Ann', receiver_last_name: 'K',
      inpost_target_point: 'WAW01', locale: 'pl',
      confirmation_email_sent_at: null, studio_email_sent_at: null,
    };
    const { supabase } = makeSucceededSupabase({
      ...freshSaleOpts(),
      emailOrderSelect: { data: unclaimed, error: null },
      studioClaim: { data: [{ id: 'o1' }], error: null },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
      claimRelease: { data: null, error: { message: 'release db down' } },
    });
    supabaseImpl = supabase;

    vi.useFakeTimers();
    let res!: Response;
    try {
      const resPromise = POST(succeededEventRequest());
      await vi.runAllTimersAsync();
      res = await resPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('email_claim_release_failed', expect.objectContaining({
      level: 'error',
      extra: expect.objectContaining({ order_id: 'o1' }),
    }));
    consoleErrorSpy.mockRestore();
  });

  it('(4) a conversions-claim UPDATE failure alerts (the server-side conversion is silently lost otherwise)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
    try {
      const { supabase } = makeSucceededSupabase({
        ...freshSaleOpts(),
        conversionsClaim: { data: null, error: { message: 'claim db down' } },
      });
      supabaseImpl = supabase;

      const res = await POST(succeededEventRequest());

      expect(res.status).toBe(200);
      expect(Sentry.captureMessage).toHaveBeenCalledWith('conversions_claim_failed', expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({ payment_intent_id: 'pi_1' }),
      }));
    } finally {
      cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
      delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
      consoleErrorSpy.mockRestore();
    }
  });

  it('(5) an unexpected throw inside trackPurchase reports to Sentry, still 200 (best-effort contract intact)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
    try {
      const { supabase } = makeSucceededSupabase({
        ...freshSaleOpts(),
        conversionsClaimThrows: true,
      });
      supabaseImpl = supabase;

      const res = await POST(succeededEventRequest());

      expect(res.status).toBe(200);
      expect(Sentry.captureException).toHaveBeenCalled();
    } finally {
      cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
      delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
      consoleErrorSpy.mockRestore();
    }
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
    // M-27: both claim-based sends carry a per-order Resend Idempotency-Key so
    // a local retry after a timed-out-but-accepted request can't double-send.
    expect(vi.mocked(emailNewOrderToStudio).mock.calls[0][0]).toMatchObject({ idempotencyKey: 'studio-new-order/o1' });
    expect(vi.mocked(emailOrderConfirmationToCustomer).mock.calls[0][0]).toMatchObject({ idempotencyKey: 'order-confirmation/o1' });
    // The claim must be ATOMIC: a plain update without the `.is(col, null)`
    // filter would let two overlapping redeliveries both claim and both send.
    expect(studioClaimWrites).toHaveLength(1);
    expect(studioClaimWrites[0].filters).toContainEqual(['is', ['studio_email_sent_at', null]]);
    expect(confirmClaimWrites).toHaveLength(1);
    expect(confirmClaimWrites[0].filters).toContainEqual(['is', ['confirmation_email_sent_at', null]]);
  });

  it('captures a Sentry message when the cart.purchased (abandoned-checkout cancel) send fails', async () => {
    vi.mocked(sendPurchasedEvent).mockRejectedValueOnce(new Error('resend down'));
    vi.mocked(Sentry.captureMessage).mockClear();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
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

    expect(res.status).toBe(200); // best-effort: the failure must not fail the webhook
    expect(sendPurchasedEvent).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'stripe_webhook_purchased_event_failed',
      expect.objectContaining({ level: 'error', extra: expect.objectContaining({ order_id: 'o1' }) }),
    );
    consoleErrorSpy.mockRestore();
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

describe('webhook_events idempotency ledger (F-18)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(createOrderShipment).mockClear();
    vi.mocked(enqueueProdigi).mockClear();
  });

  // Minimal succeeded opts for the dedup cases — the handler never runs, so
  // orders/piece_state are untouched; only the ledger select is consulted.
  const dedupOpts = {
    casUpdate: { data: [], error: null },
    shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
    variantRows: { data: [], error: null },
  };

  it('ledger row already `done`: dedupes without processing the event', async () => {
    const { supabase } = makeSucceededSupabase({
      ...dedupOpts,
      webhookEvents: { seen: { data: { id: 'we_1', status: 'done', processing_started_at: null }, error: null } },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());
    const body = (await res.json()) as { deduped?: boolean };

    expect(res.status).toBe(200);
    expect(body.deduped).toBe(true);
    // markPaid never ran ⇒ no fulfilment.
    expect(createOrderShipment).not.toHaveBeenCalled();
    expect(enqueueProdigi).not.toHaveBeenCalled();
  });

  it('in-flight `processing` lease within TTL: 409 so Stripe redelivers after the lease (M-22 — never a dropping 200)', async () => {
    const { supabase } = makeSucceededSupabase({
      ...dedupOpts,
      webhookEvents: {
        seen: { data: { id: 'we_1', status: 'processing', processing_started_at: new Date().toISOString() }, error: null },
      },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());
    const body = (await res.json()) as { received?: boolean; inFlight?: boolean };

    // A 200 here would suppress the retry: if the in-flight winner dies, the
    // event is dropped forever. 409 makes Stripe retry after the lease.
    expect(res.status).toBe(409);
    expect(body).toEqual({ received: false, inFlight: true });
    expect(createOrderShipment).not.toHaveBeenCalled();
  });

  it('seen-SELECT error: throws (5xx) instead of falling into the insert branch and a false dedupe-200 (M-21)', async () => {
    const { supabase } = makeSucceededSupabase({
      ...dedupOpts,
      webhookEvents: { seen: { data: null, error: { message: 'select down' } } },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/webhook_events seen lookup failed: select down/);
  });

  it('claim-CAS lost race (another delivery reclaimed the stale lease): 409, not a dedupe-200 (M-22)', async () => {
    const staleLease = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { supabase } = makeSucceededSupabase({
      ...dedupOpts,
      webhookEvents: {
        seen: { data: { id: 'we_1', status: 'processing', processing_started_at: staleLease }, error: null },
        claimCas: { data: null, error: null },
      },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(409);
    expect(createOrderShipment).not.toHaveBeenCalled();
  });

  it('insert-23505 race where the winning row is NOT done: 409 (M-22)', async () => {
    const { supabase } = makeSucceededSupabase({
      ...dedupOpts,
      webhookEvents: {
        insert: { error: { code: '23505', message: 'duplicate key' } },
        seenAfterInsert: {
          data: { id: 'we_1', status: 'processing', processing_started_at: new Date().toISOString() },
          error: null,
        },
      },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(409);
    expect(createOrderShipment).not.toHaveBeenCalled();
  });

  it('insert-23505 race where the winning row already reached done: dedupe-200 (the only 200 dedup case)', async () => {
    const { supabase } = makeSucceededSupabase({
      ...dedupOpts,
      webhookEvents: {
        insert: { error: { code: '23505', message: 'duplicate key' } },
        seenAfterInsert: { data: { id: 'we_1', status: 'done', processing_started_at: null }, error: null },
      },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());
    const body = (await res.json()) as { deduped?: boolean };

    expect(res.status).toBe(200);
    expect(body.deduped).toBe(true);
  });

  it('done-write and lease release are scoped to OUR claim timestamp (L-4 — a stale releaser writes nothing)', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const updateCalls: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown[]]> }> = [];
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      webhookEvents: { inserts, updateCalls },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    const claimedAt = inserts[0]?.processing_started_at;
    expect(typeof claimedAt).toBe('string');
    const doneCall = updateCalls.find((c) => c.payload.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall!.filters).toContainEqual(['eq', ['processing_started_at', claimedAt]]);
  });

  it('fresh event: inserts the row, processes, and marks it done (no dedup)', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      // default webhookEvents stub = fresh (select null) → insert ok → done ok
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());
    const body = (await res.json()) as { deduped?: boolean; received?: boolean };

    expect(res.status).toBe(200);
    expect(body.received).toBe(true);
    expect(body.deduped).toBeUndefined();
  });

  it('done-write error: the route throws so Stripe retries (never a false 200)', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      webhookEvents: { done: { error: { message: 'boom' } } },
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/webhook_events done update failed: boom/);
  });

  it('a mid-handler throw releases the lease (status=failed) so a retry reclaims immediately', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    const updateCalls: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown[]]> }> = [];
    const { supabase } = makeSupabase({
      // refunded-CAS orders UPDATE errors ⇒ releaseSale throws out of handleStripeEvent.
      ordersUpdate: { data: null, error: { message: 'db down' } },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: null, error: null },
      webhookEvents: { updates, inserts, updateCalls },
    });
    supabaseImpl = supabase;

    await expect(POST(refundedEventRequest())).rejects.toThrow(/db down/);
    // Lease handed back (not left `processing`) so the next Stripe retry reclaims
    // it immediately, regardless of whether the retry lands inside the 5-min lease.
    // Without this the retry would be deduped → fulfilment silently dropped.
    expect(updates).toContainEqual({ status: 'failed', processing_started_at: null });
    // L-4: the release is CAS'd on OUR claim timestamp — a stale releaser whose
    // lease was reclaimed by a newer delivery must write nothing.
    const claimedAt = inserts[0]?.processing_started_at;
    expect(typeof claimedAt).toBe('string');
    const releaseCall = updateCalls.find((c) => c.payload.status === 'failed');
    expect(releaseCall).toBeDefined();
    expect(releaseCall!.filters).toContainEqual(['eq', ['processing_started_at', claimedAt]]);
  });
});

describe('webhook markPaid promo settlement (Phase 2)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  const promoOrderCas = { data: [{ id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' }], error: null };
  const baseOpts = {
    casUpdate: promoOrderCas,
    shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
    soldCount: { count: 1, error: null },
    ceramicCount: { count: 1, error: null },
    variantRows: { data: [], error: null },
  };

  it('settles the redemption to redeemed for an order with a promo', async () => {
    const { supabase, rpcCalls } = makeSucceededSupabase(baseOpts);
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(rpcCalls).toContainEqual({
      fn: 'settle_promo_redemption',
      params: { p_order_id: 'o1', p_status: 'redeemed' },
    });
  });

  it('never calls the settle RPC for an order without a promo', async () => {
    const { supabase, rpcCalls } = makeSucceededSupabase({
      ...baseOpts,
      casUpdate: { data: [{ id: 'o1', private_sale_id: null, promo_code: null }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(0);
  });

  it('throws (Stripe retries) when the settle RPC errors', async () => {
    const { supabase } = makeSucceededSupabase({
      ...baseOpts,
      rpc: () => ({ data: null, error: { message: 'db down' } }),
    });
    supabaseImpl = supabase;

    await expect(POST(succeededEventRequest())).rejects.toThrow(/promo settle failed/);
  });

  it('settle=false (row already released): re-claims and settles redeemed again', async () => {
    // 1st settle → false; claim → true; 2nd settle → true.
    let settles = 0;
    const { supabase, rpcCalls } = makeSucceededSupabase({
      ...baseOpts,
      promoCodesSelect: { data: { id: 'promo1' }, error: null },
      rpc: (fn: string) => {
        if (fn === 'settle_promo_redemption') {
          settles += 1;
          return { data: settles > 1, error: null };
        }
        return { data: true, error: null };
      },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(rpcCalls).toContainEqual({
      fn: 'claim_promo_redemption',
      params: { p_promo_id: 'promo1', p_order_id: 'o1' },
    });
    expect(rpcCalls.filter((c) => c.fn === 'settle_promo_redemption')).toHaveLength(2);
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith('promo_settle_lost_capacity', expect.anything());
  });

  it('settle=false and re-claim=false (capacity gone): alerts promo_settle_lost_capacity and continues without throwing', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      ...baseOpts,
      promoCodesSelect: { data: { id: 'promo1' }, error: null },
      rpc: () => ({ data: false, error: null }),
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());
    consoleErrorSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'promo_settle_lost_capacity',
      expect.objectContaining({ extra: expect.objectContaining({ order_id: 'o1', promo_code: 'WELCOME10' }) }),
    );
  });
});

describe('webhook releaseHold promo settlement (Phase 2)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  it('settles the redemption to released for a failed order with a promo', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [{ id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' }], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(canceledEventRequest());

    expect(res.status).toBe(200);
    expect(calls.rpcCalls).toContainEqual({
      fn: 'settle_promo_redemption',
      params: { p_order_id: 'o1', p_status: 'released' },
    });
  });

  it('does not call the settle RPC without a promo', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(canceledEventRequest());

    expect(res.status).toBe(200);
    expect(calls.rpcCalls).toHaveLength(0);
  });

  it('release settle is best-effort: an RPC error is logged + Sentry-flagged, the route still 200s', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSupabase({
      ordersUpdate: { data: [{ id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' }], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
      rpc: { data: null, error: { message: 'db down' } },
    });
    supabaseImpl = supabase;

    const res = await POST(canceledEventRequest());
    consoleErrorSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'promo_release_settle_failed',
      expect.objectContaining({ extra: expect.objectContaining({ order_id: 'o1' }) }),
    );
  });
});

describe('webhook releaseSale promo settlement (Phase 2)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  it('pending→refunded branch settles the redemption released (refund before success cannot strand it)', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: [{ data: [{ id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' }], error: null }],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.rpcCalls).toContainEqual({
      fn: 'settle_promo_redemption',
      params: { p_order_id: 'o1', p_status: 'released' },
    });
  });

  it('paid→refunded branch performs NO promo settlement (redeemed stays redeemed)', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: [
        { data: [], error: null }, // pending CAS misses
        {
          data: [{ id: 'o1', private_sale_id: null, promo_code: 'WELCOME10', subtotal: 10000, shipping: 2000, currency: 'pln', marketing: null }],
          error: null,
        },
      ],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.rpcCalls).toHaveLength(0);
  });

  it('already-refunded resume branch settles released best-effort', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [], error: null }, // both CAS attempts miss
      ordersSelect: { data: { id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.rpcCalls).toContainEqual({
      fn: 'settle_promo_redemption',
      params: { p_order_id: 'o1', p_status: 'released' },
    });
  });
});
