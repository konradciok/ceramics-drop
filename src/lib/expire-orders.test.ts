import { describe, it, expect, vi } from 'vitest';
import {
  expireAbandonedOrders,
  claimExpiryLease,
  releaseExpiryLease,
  finalizeExpiry,
  EXPIRY_CLAIM_LEASE_MS,
  STALE_REFUND_PENDING_MS,
  type AbandonedOrder,
  type CancelOutcome,
  type ExpireOrdersDeps,
} from './expire-orders';

function order(id: string): AbandonedOrder {
  return { id, payment_intent_id: `pi_${id}` };
}

function deps(overrides: Partial<ExpireOrdersDeps> = {}): ExpireOrdersDeps {
  return {
    loadAbandoned: vi.fn().mockResolvedValue([]),
    claimExpiry: vi.fn().mockResolvedValue('claim-1'),
    cancelIntent: vi.fn().mockResolvedValue('canceled' as CancelOutcome),
    expireOrder: vi.fn().mockResolvedValue(true),
    warn: vi.fn(),
    alertPaidOnPending: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('expireAbandonedOrders', () => {
  it("'canceled' outcome → expireOrder called and counted in expired", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('canceled' as CancelOutcome),
      expireOrder: vi.fn().mockResolvedValue(true),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'claim-1');
    expect(result).toEqual({ scanned: 1, skipped: 0, expired: 1, stillActive: 0, errors: 0 });
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("'canceled' but expireOrder returns false → NOT counted in expired", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('canceled' as CancelOutcome),
      expireOrder: vi.fn().mockResolvedValue(false),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'claim-1');
    expect(result).toEqual({ scanned: 1, skipped: 0, expired: 0, stillActive: 0, errors: 0 });
  });

  it("'paid' outcome → expireOrder NOT called, counted in stillActive, warn called", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('paid' as CancelOutcome),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn).toHaveBeenCalledWith(expect.any(String), { orderId: 'a', paymentIntentId: 'pi_a' });
    // M-15: a paid/processing PI on a pending order (likely a missed webhook) must
    // ALERT, not just warn to logs.
    expect(d.alertPaidOnPending).toHaveBeenCalledTimes(1);
    expect(d.alertPaidOnPending).toHaveBeenCalledWith('a');
    expect(result).toEqual({ scanned: 1, skipped: 0, expired: 0, stillActive: 1, errors: 0 });
  });

  it("'error' outcome → expireOrder NOT called, counted in errors", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('error' as CancelOutcome),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, skipped: 0, expired: 0, stillActive: 0, errors: 1 });
  });

  it('mixed batch → correct aggregate counts and scanned === input length', async () => {
    const batch = [order('a'), order('b'), order('c'), order('d'), order('e')];
    const outcomes: Record<string, CancelOutcome> = {
      pi_a: 'canceled',
      pi_b: 'canceled',
      pi_c: 'paid',
      pi_d: 'error',
      pi_e: 'canceled',
    };
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue(batch),
      cancelIntent: vi.fn().mockImplementation((pi: string) => Promise.resolve(outcomes[pi])),
      // 'a' and 'e' actually expire; 'b' was already gone (false).
      expireOrder: vi.fn().mockImplementation((o: AbandonedOrder) => Promise.resolve(o.id !== 'b')),
    });
    const result = await expireAbandonedOrders(d);
    expect(result).toEqual({ scanned: 5, skipped: 0, expired: 2, stillActive: 1, errors: 1 });
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it('propagates a loadAbandoned failure (caller must handle it)', async () => {
    const d = deps({ loadAbandoned: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(expireAbandonedOrders(d)).rejects.toThrow('db down');
    expect(d.cancelIntent).not.toHaveBeenCalled();
  });

  it('empty batch → all zeros', async () => {
    const d = deps({ loadAbandoned: vi.fn().mockResolvedValue([]) });
    const result = await expireAbandonedOrders(d);
    expect(result).toEqual({ scanned: 0, skipped: 0, expired: 0, stillActive: 0, errors: 0 });
    expect(d.cancelIntent).not.toHaveBeenCalled();
    expect(d.expireOrder).not.toHaveBeenCalled();
  });

  // M-5 pending-consumer guard: the claim runs BEFORE the irreversible PI
  // cancel, so a refund-pending order (marker set after loadAbandoned read it)
  // is skipped entirely — the interleaving a final-update predicate would miss.
  it('claim denied (refund-pending / concurrently claimed): PI cancel and expiry never run, counted as skipped', async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      claimExpiry: vi.fn().mockResolvedValue(null),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.cancelIntent).not.toHaveBeenCalled();
    expect(d.expireOrder).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, skipped: 1, expired: 0, stillActive: 0, errors: 0 });
  });

  it('claim always precedes the PI cancel (the irreversible side effect)', async () => {
    const seq: string[] = [];
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      claimExpiry: vi.fn().mockImplementation(async () => { seq.push('claim'); return 'claim-1'; }),
      cancelIntent: vi.fn().mockImplementation(async () => { seq.push('cancel'); return 'canceled' as CancelOutcome; }),
    });
    await expireAbandonedOrders(d);
    expect(seq).toEqual(['claim', 'cancel']);
  });

  // A refund-pending order whose Stripe retries ran out is captured money no
  // consumer may touch — the sweep must alert on a STALE marker (at-most-once
  // via the M-15 claim), never skip it silently forever.
  it('claim denied with a STALE refund_pending_at marker: fires alertPaidOnPending (still counted skipped)', async () => {
    const stale = new Date(Date.now() - STALE_REFUND_PENDING_MS - 60 * 1000).toISOString();
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([{ ...order('a'), refund_pending_at: stale }]),
      claimExpiry: vi.fn().mockResolvedValue(null),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.alertPaidOnPending).toHaveBeenCalledTimes(1);
    expect(d.alertPaidOnPending).toHaveBeenCalledWith('a');
    expect(result.skipped).toBe(1);
  });

  it('claim denied with a FRESH refund_pending_at marker: no alert (the webhook is still converging it)', async () => {
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([{ ...order('a'), refund_pending_at: fresh }]),
      claimExpiry: vi.fn().mockResolvedValue(null),
    });
    await expireAbandonedOrders(d);
    expect(d.alertPaidOnPending).not.toHaveBeenCalled();
  });

  it('claim denied without a marker (plain concurrent lease): no alert', async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      claimExpiry: vi.fn().mockResolvedValue(null),
    });
    await expireAbandonedOrders(d);
    expect(d.alertPaidOnPending).not.toHaveBeenCalled();
  });

  // Recovery (plan c2): a cancelIntent failure after the claim leaves the order
  // pending (never terminal); the next sweep reclaims (stale lease) and succeeds.
  it('cancelIntent failure after the claim: no terminal write; the next sweep reclaims and completes', async () => {
    const claimExpiry = vi.fn().mockResolvedValue('claim-1');
    const expireOrder = vi.fn().mockResolvedValue(true);
    const failing = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      claimExpiry,
      cancelIntent: vi.fn().mockResolvedValue('error' as CancelOutcome),
      expireOrder,
    });
    const first = await expireAbandonedOrders(failing);
    expect(expireOrder).not.toHaveBeenCalled();
    expect(first.errors).toBe(1);

    // Next tick: same order still pending, lease stale → reclaim succeeds.
    const second = await expireAbandonedOrders(deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      claimExpiry: vi.fn().mockResolvedValue('claim-2'),
      cancelIntent: vi.fn().mockResolvedValue('canceled' as CancelOutcome),
      expireOrder,
    }));
    expect(expireOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'claim-2');
    expect(second.expired).toBe(1);
  });
});

// ── claimExpiryLease / releaseExpiryLease (the shared consumer-side CAS) ──────

type Filter = { method: string; args: unknown[] };

function fakeOrdersUpdate(result: { data: unknown; error: { message: string } | null }) {
  const filters: Filter[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const node: Record<string, unknown> = {
    eq: (...args: unknown[]) => { filters.push({ method: 'eq', args }); return node; },
    is: (...args: unknown[]) => { filters.push({ method: 'is', args }); return node; },
    or: (...args: unknown[]) => { filters.push({ method: 'or', args }); return node; },
    select: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  const supabase = {
    from: (table: string) => {
      expect(table).toBe('orders');
      return { update: (payload: Record<string, unknown>) => { payloads.push(payload); return node; } };
    },
  };
  return { supabase, filters, payloads };
}

describe('claimExpiryLease', () => {
  it('claims with the full guard: status=pending, refund_pending_at IS NULL, no active lease — and returns the token', async () => {
    const { supabase, filters, payloads } = fakeOrdersUpdate({ data: [{ id: 'o1' }], error: null });
    const now = Date.parse('2026-08-13T12:00:00.000Z');

    const token = await claimExpiryLease(supabase as never, 'o1', now);

    expect(token).toBe('2026-08-13T12:00:00.000Z');
    expect(payloads).toEqual([{ expiry_claim_at: '2026-08-13T12:00:00.000Z' }]);
    expect(filters).toContainEqual({ method: 'eq', args: ['id', 'o1'] });
    expect(filters).toContainEqual({ method: 'eq', args: ['status', 'pending'] });
    expect(filters).toContainEqual({ method: 'is', args: ['refund_pending_at', null] });
    const staleBefore = new Date(now - EXPIRY_CLAIM_LEASE_MS).toISOString();
    expect(filters).toContainEqual({ method: 'or', args: [`expiry_claim_at.is.null,expiry_claim_at.lt.${staleBefore}`] });
  });

  it('returns null when the CAS matches no row (refund-pending, active lease, or no longer pending)', async () => {
    const { supabase } = fakeOrdersUpdate({ data: [], error: null });
    expect(await claimExpiryLease(supabase as never, 'o1')).toBeNull();
  });

  it('throws on a CAS error (the sweep alert path handles it)', async () => {
    const { supabase } = fakeOrdersUpdate({ data: null, error: { message: 'db down' } });
    await expect(claimExpiryLease(supabase as never, 'o1')).rejects.toThrow(/db down/);
  });
});

// ── finalizeExpiry (pieces first, lease-fenced terminal CAS last) ─────────────

function fakeFinalizeSupabase(opts: {
  pieceResult?: { data: unknown; error: { message: string } | null };
  ordersResult?: { data: unknown; error: { message: string } | null };
  rpcResult?: { data: unknown; error: { message: string } | null };
}) {
  const seq: string[] = [];
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const ordersFilters: Filter[] = [];
  const piecePayloads: Array<Record<string, unknown>> = [];
  const ordersPayloads: Array<Record<string, unknown>> = [];
  const mkNode = (result: { data: unknown; error: { message: string } | null }, filters?: Filter[]) => {
    const node: Record<string, unknown> = {
      select: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    node.eq = (...args: unknown[]) => { filters?.push({ method: 'eq', args }); return node; };
    return node;
  };
  const supabase = {
    rpc: async (fn: string, params: Record<string, unknown>) => {
      seq.push(`rpc:${fn}`);
      rpcCalls.push({ fn, params });
      return opts.rpcResult ?? { data: true, error: null };
    },
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        seq.push(table);
        if (table === 'piece_state') {
          piecePayloads.push(payload);
          return mkNode(opts.pieceResult ?? { data: [{ product_id: 'k01' }], error: null });
        }
        ordersPayloads.push(payload);
        return mkNode(opts.ordersResult ?? { data: [{ id: 'o1' }], error: null }, ordersFilters);
      },
    }),
  };
  return { supabase, seq, ordersFilters, piecePayloads, ordersPayloads, rpcCalls };
}

describe('finalizeExpiry', () => {
  it('releases pieces FIRST, then runs the terminal CAS fenced to the claim token (plan Task-2 ordering)', async () => {
    const { supabase, seq, ordersFilters, ordersPayloads } = fakeFinalizeSupabase({});

    const expired = await finalizeExpiry(supabase as never, { id: 'o1', private_sale_id: null }, 'claim-1');

    expect(expired).toBe(true);
    expect(seq).toEqual(['piece_state', 'orders']);
    expect(ordersPayloads).toEqual([{ status: 'expired', expiry_claim_at: null }]);
    expect(ordersFilters).toContainEqual({ method: 'eq', args: ['status', 'pending'] });
    expect(ordersFilters).toContainEqual({ method: 'eq', args: ['expiry_claim_at', 'claim-1'] });
  });

  it('routes private-sale pieces to sold, never available', async () => {
    const { supabase, piecePayloads } = fakeFinalizeSupabase({});

    await finalizeExpiry(supabase as never, { id: 'o1', private_sale_id: 'ps_1' }, 'claim-1');

    expect(piecePayloads[0]).toMatchObject({ status: 'sold' });
  });

  // Plan c3 (cron leg): a piece-release failure must throw BEFORE any terminal
  // write — the order stays pending, the lease goes stale, the next sweep
  // retries. Terminal-first would strand reserved pieces forever (and leak
  // lapsed private-sale reservations into public checkout).
  it('piece-release failure: throws, terminal CAS never runs (order stays pending, next sweep retries)', async () => {
    const { supabase, seq } = fakeFinalizeSupabase({
      pieceResult: { data: null, error: { message: 'piece_state down' } },
    });

    await expect(finalizeExpiry(supabase as never, { id: 'o1', private_sale_id: null }, 'claim-1'))
      .rejects.toThrow(/piece_state down/);
    expect(seq).toEqual(['piece_state']);
  });

  it('fenced CAS matches nothing (ownership lost / already handled): returns false, never overwrites', async () => {
    const { supabase } = fakeFinalizeSupabase({ ordersResult: { data: [], error: null } });

    const expired = await finalizeExpiry(supabase as never, { id: 'o1', private_sale_id: null }, 'claim-1');

    expect(expired).toBe(false);
  });

  it('throws on a terminal-CAS error (sweep alert path handles it; retry converges)', async () => {
    const { supabase } = fakeFinalizeSupabase({ ordersResult: { data: null, error: { message: 'orders down' } } });

    await expect(finalizeExpiry(supabase as never, { id: 'o1', private_sale_id: null }, 'claim-1'))
      .rejects.toThrow(/orders down/);
  });

  it('settles the promo redemption released AFTER the terminal CAS, for an expired order with a promo', async () => {
    const { supabase, seq, rpcCalls } = fakeFinalizeSupabase({});

    const expired = await finalizeExpiry(
      supabase as never,
      { id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' },
      'claim-1',
    );

    expect(expired).toBe(true);
    expect(seq).toEqual(['piece_state', 'orders', 'rpc:settle_promo_redemption']);
    expect(rpcCalls).toEqual([
      { fn: 'settle_promo_redemption', params: { p_order_id: 'o1', p_status: 'released' } },
    ]);
  });

  it('no promo → no settle RPC', async () => {
    const { supabase, rpcCalls } = fakeFinalizeSupabase({});

    await finalizeExpiry(supabase as never, { id: 'o1', private_sale_id: null }, 'claim-1');

    expect(rpcCalls).toEqual([]);
  });

  it('fenced CAS matched nothing (ownership lost) → no settle (the new owner converges; reconcile sweep backstops)', async () => {
    const { supabase, rpcCalls } = fakeFinalizeSupabase({ ordersResult: { data: [], error: null } });

    await finalizeExpiry(
      supabase as never,
      { id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' },
      'claim-1',
    );

    expect(rpcCalls).toEqual([]);
  });

  it('promo settle failure is best-effort: logged, never throws (the reconcile sweep converges it)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = fakeFinalizeSupabase({ rpcResult: { data: null, error: { message: 'db down' } } });

    const expired = await finalizeExpiry(
      supabase as never,
      { id: 'o1', private_sale_id: null, promo_code: 'WELCOME10' },
      'claim-1',
    );
    errSpy.mockRestore();

    expect(expired).toBe(true);
  });
});

describe('releaseExpiryLease', () => {
  it('clears only its own lease (CAS on the exact token)', async () => {
    const { supabase, filters, payloads } = fakeOrdersUpdate({ data: [], error: null });

    await releaseExpiryLease(supabase as never, 'o1', 'claim-1');

    expect(payloads).toEqual([{ expiry_claim_at: null }]);
    expect(filters).toContainEqual({ method: 'eq', args: ['id', 'o1'] });
    expect(filters).toContainEqual({ method: 'eq', args: ['expiry_claim_at', 'claim-1'] });
  });

  it('never throws (best-effort — a stuck lease self-heals via the TTL)', async () => {
    const { supabase } = fakeOrdersUpdate({ data: null, error: { message: 'db down' } });
    await expect(releaseExpiryLease(supabase as never, 'o1', 'claim-1')).resolves.toBeUndefined();
  });
});
