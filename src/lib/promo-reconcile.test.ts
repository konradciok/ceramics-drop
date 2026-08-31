import { describe, it, expect, vi } from 'vitest';
import {
  sweepStalePromoRedemptions,
  STALE_PENDING_REDEMPTION_MS,
} from './promo-reconcile';

type Row = { id: string; order_id: string; orders: { status: string } | null };
type Result = { data: unknown; error: { message: string } | null };

/** Query chain for `.select().eq().lt().limit()` resolving `queryResult`; rpc records calls. */
function fakeSupabase(
  queryResult: Result,
  rpcResult: Result | ((fn: string, params: Record<string, unknown>) => Result) = { data: true, error: null },
) {
  const filters: Array<{ method: string; args: unknown[] }> = [];
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const chain: Record<string, unknown> = {
    eq: (...args: unknown[]) => { filters.push({ method: 'eq', args }); return chain; },
    lt: (...args: unknown[]) => { filters.push({ method: 'lt', args }); return chain; },
    limit: async (...args: unknown[]) => { filters.push({ method: 'limit', args }); return queryResult; },
  };
  const supabase = {
    from: vi.fn(() => ({ select: vi.fn(() => chain) })),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      return typeof rpcResult === 'function' ? rpcResult(fn, params) : rpcResult;
    },
  };
  return { supabase, filters, rpcCalls };
}

const rows = (r: Row[]): Result => ({ data: r, error: null });

describe('sweepStalePromoRedemptions', () => {
  it('exposes a 2 h staleness threshold', () => {
    expect(STALE_PENDING_REDEMPTION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('queries only stale pending redemptions', async () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    const { supabase, filters } = fakeSupabase(rows([]));

    await sweepStalePromoRedemptions(supabase as never, now);

    expect(filters).toContainEqual({ method: 'eq', args: ['status', 'pending'] });
    expect(filters).toContainEqual({
      method: 'lt',
      args: ['created_at', new Date(now - STALE_PENDING_REDEMPTION_MS).toISOString()],
    });
  });

  it('settles released for terminal unpaid orders and redeemed for paid orders; leaves pending orders alone', async () => {
    const { supabase, rpcCalls } = fakeSupabase(
      rows([
        { id: 'r1', order_id: 'o-failed', orders: { status: 'failed' } },
        { id: 'r2', order_id: 'o-expired', orders: { status: 'expired' } },
        { id: 'r3', order_id: 'o-refunded', orders: { status: 'refunded' } },
        { id: 'r4', order_id: 'o-paid', orders: { status: 'paid' } },
        { id: 'r5', order_id: 'o-pending', orders: { status: 'pending' } },
        { id: 'r6', order_id: 'o-gone', orders: null },
      ]),
    );

    const result = await sweepStalePromoRedemptions(supabase as never);

    expect(rpcCalls).toEqual([
      { fn: 'settle_promo_redemption', params: { p_order_id: 'o-failed', p_status: 'released' } },
      { fn: 'settle_promo_redemption', params: { p_order_id: 'o-expired', p_status: 'released' } },
      { fn: 'settle_promo_redemption', params: { p_order_id: 'o-refunded', p_status: 'released' } },
      { fn: 'settle_promo_redemption', params: { p_order_id: 'o-paid', p_status: 'redeemed' } },
    ]);
    expect(result).toMatchObject({ scanned: 6, released: 3, redeemed: 1, skipped: 2, errors: 0 });
    // Paid-but-pending is markPaid's miss — surfaced for the caller to alert on.
    expect(result.paidReconciledOrderIds).toEqual(['o-paid']);
  });

  it('a per-row settle failure is counted and does not stop the sweep', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase, rpcCalls } = fakeSupabase(
      rows([
        { id: 'r1', order_id: 'o1', orders: { status: 'failed' } },
        { id: 'r2', order_id: 'o2', orders: { status: 'expired' } },
      ]),
      (fn, params) =>
        params.p_order_id === 'o1' ? { data: null, error: { message: 'db down' } } : { data: true, error: null },
    );

    const result = await sweepStalePromoRedemptions(supabase as never);
    errSpy.mockRestore();

    expect(rpcCalls).toHaveLength(2); // o2 still processed after o1's failure
    expect(result).toMatchObject({ released: 1, errors: 1 });
  });

  it('throws when the query itself fails (worker self-alert path)', async () => {
    const { supabase } = fakeSupabase({ data: null, error: { message: 'db down' } });

    await expect(sweepStalePromoRedemptions(supabase as never)).rejects.toThrow(/db down/);
  });
});
