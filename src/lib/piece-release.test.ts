import { describe, it, expect } from 'vitest';
import { releaseTargetStatus, releaseReservedPieces, releaseOrphanedCheckoutHold } from './piece-release';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('releaseTargetStatus', () => {
  it('normal order (no private_sale_id) → pieces relist as available', () => {
    expect(releaseTargetStatus({ private_sale_id: null })).toBe('available');
  });

  it('private-sale order → pieces return to/stay sold (never relisted publicly)', () => {
    expect(releaseTargetStatus({ private_sale_id: 'ps_123' })).toBe('sold');
  });

  it('missing private_sale_id field → treated as a normal order', () => {
    expect(releaseTargetStatus({})).toBe('available');
  });

  it('undefined private_sale_id → available', () => {
    expect(releaseTargetStatus({ private_sale_id: undefined })).toBe('available');
  });
});

/**
 * Minimal fake of the chained supabase query builder used by releaseReservedPieces:
 *   supabase.from('piece_state').update(...).eq(...).eq(...).select('product_id')
 * Records the table, update payload, eq filters and selected columns, and resolves
 * with the preset { data, error }.
 */
function fakeSupabase(result: { data: unknown; error: unknown }) {
  const calls = {
    table: undefined as string | undefined,
    update: undefined as unknown,
    eq: [] as Array<[string, unknown]>,
    select: undefined as string | undefined,
  };
  const builder = {
    update(payload: unknown) {
      calls.update = payload;
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.eq.push([col, val]);
      return builder;
    },
    select(cols: string) {
      calls.select = cols;
      return Promise.resolve(result);
    },
  };
  const supabase = {
    from(table: string) {
      calls.table = table;
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

describe('releaseReservedPieces', () => {
  it('normal order: relists reserved pieces as available and returns freed ids', async () => {
    const { supabase, calls } = fakeSupabase({
      data: [{ product_id: 'k01' }, { product_id: 'k02' }],
      error: null,
    });

    const freed = await releaseReservedPieces(supabase, { id: 'o1', private_sale_id: null });

    expect(freed).toEqual(['k01', 'k02']);
    expect(calls.table).toBe('piece_state');
    expect(calls.update).toEqual({ status: 'available', reserved_until: null, order_id: null });
    // Only this order's still-reserved rows are touched.
    expect(calls.eq).toContainEqual(['order_id', 'o1']);
    expect(calls.eq).toContainEqual(['status', 'reserved']);
    expect(calls.select).toBe('product_id');
  });

  it('private-sale order: reserved pieces return to sold (never relisted publicly)', async () => {
    const { supabase, calls } = fakeSupabase({ data: [{ product_id: 'k09' }], error: null });

    const freed = await releaseReservedPieces(supabase, { id: 'o2', private_sale_id: 'ps_9' });

    expect(freed).toEqual(['k09']);
    expect(calls.update).toEqual({ status: 'sold', reserved_until: null, order_id: null });
  });

  it('idempotent: nothing reserved → returns [] with no surprise', async () => {
    const { supabase } = fakeSupabase({ data: [], error: null });
    await expect(releaseReservedPieces(supabase, { id: 'o3', private_sale_id: null })).resolves.toEqual([]);
  });

  it('throws on a piece_state failure so the caller can surface it (no silent stuck holds)', async () => {
    const { supabase } = fakeSupabase({ data: null, error: { message: 'db down' } });
    await expect(releaseReservedPieces(supabase, { id: 'o4', private_sale_id: null })).rejects.toThrow(
      /releaseReservedPieces failed for order o4: db down/,
    );
  });
});

describe('releaseOrphanedCheckoutHold', () => {
  function fakeRpc(result: { data: unknown; error: unknown }) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const supabase = {
      rpc(fn: string, params: Record<string, unknown>) {
        calls.push([fn, params]);
        return Promise.resolve(result);
      },
    } as unknown as SupabaseClient;
    return { supabase, calls };
  }

  it('normal order: asks the guarded RPC to relist as available', async () => {
    const { supabase, calls } = fakeRpc({ data: 'released', error: null });
    await expect(releaseOrphanedCheckoutHold(supabase, { id: 'o1', private_sale_id: null })).resolves.toBe('released');
    expect(calls).toEqual([['release_orphaned_checkout_hold', { p_order_id: 'o1', p_target_status: 'available' }]]);
  });

  it('private-sale order: pieces go back to sold', async () => {
    const { supabase, calls } = fakeRpc({ data: 'released', error: null });
    await releaseOrphanedCheckoutHold(supabase, { id: 'o2', private_sale_id: 'ps_9' });
    expect(calls[0][1]).toEqual({ p_order_id: 'o2', p_target_status: 'sold' });
  });

  it('passes through live_order (a live order owns the hold; nothing freed)', async () => {
    const { supabase } = fakeRpc({ data: 'live_order', error: null });
    await expect(releaseOrphanedCheckoutHold(supabase, { id: 'o3' })).resolves.toBe('live_order');
  });

  it('throws on an RPC error', async () => {
    const { supabase } = fakeRpc({ data: null, error: { message: 'db down' } });
    await expect(releaseOrphanedCheckoutHold(supabase, { id: 'o4' })).rejects.toThrow(
      /releaseOrphanedCheckoutHold failed for order o4: db down/,
    );
  });

  it('throws on an unexpected result rather than guessing', async () => {
    const { supabase } = fakeRpc({ data: null, error: null });
    await expect(releaseOrphanedCheckoutHold(supabase, { id: 'o5' })).rejects.toThrow(/unexpected result/);
  });
});
