import { describe, it, expect } from 'vitest';
import { countCeramicOrderItems, isUnderfulfilled, type CeramicCountClient } from './fulfillment';

type Row = { order_id: string; product_id: string; variant: unknown | null };

/** Fake Supabase that actually applies the .eq()/.is() filters to in-memory rows. */
function fakeSupabase(rows: Row[]): CeramicCountClient {
  return {
    from() {
      return {
        select() {
          let filtered = rows.slice();
          const chain = {
            eq(column: string, value: string) {
              filtered = filtered.filter((r) => (r as Record<string, unknown>)[column] === value);
              return chain as never;
            },
            is(column: string, value: null) {
              filtered = filtered.filter((r) => (r as Record<string, unknown>)[column] === value);
              return Promise.resolve({ count: filtered.length, error: null });
            },
          };
          return chain;
        },
      };
    },
  };
}

describe('countCeramicOrderItems', () => {
  it('counts only ceramic lines (variant IS NULL) for the order', async () => {
    const rows: Row[] = [
      { order_id: 'o1', product_id: 'k01', variant: null },
      { order_id: 'o1', product_id: 'fap01', variant: { size: 'a3' } },
      { order_id: 'o1', product_id: 'fap01', variant: { size: 'a4' } },
      { order_id: 'o2', product_id: 'k02', variant: null }, // other order
    ];
    const { count } = await countCeramicOrderItems(fakeSupabase(rows), 'o1');
    expect(count).toBe(1); // only k01
  });

  it('returns 0 for a print-only order (so expected = fulfilled = 0)', async () => {
    const rows: Row[] = [
      { order_id: 'o3', product_id: 'fap01', variant: { size: 'a3' } },
      { order_id: 'o3', product_id: 'fap02', variant: { size: 'a4' } },
    ];
    const { count } = await countCeramicOrderItems(fakeSupabase(rows), 'o3');
    expect(count).toBe(0);
  });
});

describe('isUnderfulfilled', () => {
  it('print-only order (0 expected, 0 sold) is NOT under-fulfilled', () => {
    expect(isUnderfulfilled(0, 0)).toBe(false);
  });

  it('mixed order with all ceramics sold passes', () => {
    expect(isUnderfulfilled(2, 2)).toBe(false);
  });

  it('mixed order missing a ceramic sale is under-fulfilled (→ refund)', () => {
    expect(isUnderfulfilled(1, 2)).toBe(true);
  });
});
