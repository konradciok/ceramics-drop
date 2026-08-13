import { describe, it, expect, vi } from 'vitest';
import {
  expireAbandonedOrders,
  claimExpiryLease,
  releaseExpiryLease,
  EXPIRY_CLAIM_LEASE_MS,
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
    expect(d.expireOrder).toHaveBeenCalledWith('a', 'claim-1');
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
    expect(d.expireOrder).toHaveBeenCalledWith('a', 'claim-1');
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
      expireOrder: vi.fn().mockImplementation((id: string) => Promise.resolve(id !== 'b')),
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
    expect(expireOrder).toHaveBeenCalledWith('a', 'claim-2');
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
