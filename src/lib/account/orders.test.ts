import { describe, it, expect } from 'vitest';
import { listAccountOrders, getAccountOrder } from './orders';

/**
 * M-5 failed-consumer contract: a `failed` order (possibly a captured-then-
 * refunded double payment) must be absent from the account list AND the
 * detail read. The guarantee is the SQL-level `.in('status', […])` filter —
 * these tests pin that filter so a refactor can't silently widen it.
 */

type Filter = { method: string; args: unknown[] };

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const filters: Filter[] = [];
  const node: Record<string, unknown> = {
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['eq', 'in', 'order', 'limit'] as const) {
    node[method] = (...args: unknown[]) => {
      filters.push({ method, args });
      return node;
    };
  }
  const supabase = { from: () => ({ select: () => node }) };
  return { supabase, filters };
}

describe('account order reads — failed-status contract (M-5)', () => {
  it('listAccountOrders queries only settled statuses (paid/refunded) — failed can never appear', async () => {
    const { supabase, filters } = fakeSupabase({ data: [], error: null });

    const { orders } = await listAccountOrders('user-1', { supabase: supabase as never });

    expect(orders).toEqual([]);
    expect(filters).toContainEqual({ method: 'in', args: ['status', ['paid', 'refunded']] });
    expect(filters).toContainEqual({ method: 'eq', args: ['user_id', 'user-1'] });
  });

  it('getAccountOrder returns null for a failed order even for its owner (uniform 404)', async () => {
    // The status filter excludes the row at SQL level → maybeSingle sees null.
    const { supabase, filters } = fakeSupabase({ data: null, error: null });

    const result = await getAccountOrder('00000000-0000-0000-0000-000000000001', 'user-1', {
      supabase: supabase as never,
    });

    expect(result).toBeNull();
    expect(filters).toContainEqual({ method: 'in', args: ['status', ['paid', 'refunded']] });
    expect(filters).toContainEqual({ method: 'eq', args: ['user_id', 'user-1'] });
  });
});
