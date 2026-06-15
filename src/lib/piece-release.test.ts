import { describe, it, expect } from 'vitest';
import { releaseTargetStatus, releaseReservedPieces } from './piece-release';
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
    await expect(releaseReservedPieces(supabase, { id: 'o4', private_sale_id: null })).rejects.toThrow('db down');
  });
});
