import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isAvailable } from './inventory';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('./supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));

/** Mirrors the chain-mock idiom in src/lib/catalog/repository.test.ts. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  for (const m of ['select', 'or', 'eq', 'abortSignal']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  return chain;
}

describe('getSoldIds / getShowroomIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits one shared piece_state query into sold vs. showroom id lists', async () => {
    const { getSoldIds, getShowroomIds } = await import('./inventory');
    mockFrom.mockReturnValue(
      makeChain({
        data: [
          { product_id: 'k01', status: 'sold', showroom: false },
          { product_id: 'k02', status: 'sold', showroom: true },
          { product_id: 'k03', status: 'available', showroom: true },
        ],
        error: null,
      }),
    );

    await expect(getSoldIds()).resolves.toEqual(['k01', 'k02']);
    await expect(getShowroomIds()).resolves.toEqual(['k02', 'k03']);
    // fetchPieceState is request-scoped (React cache) per module instance, not
    // asserted here across the two calls since Vitest re-imports fresh state;
    // the query shape itself is what's under test.
    expect(mockFrom).toHaveBeenCalledWith('piece_state');
  });

  it('propagates a Supabase error from the shared fetch', async () => {
    const { getSoldIds } = await import('./inventory');
    mockFrom.mockReturnValue(makeChain({ data: null, error: { message: 'boom' } }));
    await expect(getSoldIds()).rejects.toEqual({ message: 'boom' });
  });
});

describe('isAvailable', () => {
  const now = new Date('2026-06-02T12:00:00Z');
  it('available when status available', () => {
    expect(isAvailable({ status: 'available', reserved_until: null }, now)).toBe(true);
  });
  it('unavailable when sold', () => {
    expect(isAvailable({ status: 'sold', reserved_until: null }, now)).toBe(false);
  });
  it('unavailable while reservation is live', () => {
    expect(isAvailable({ status: 'reserved', reserved_until: '2026-06-02T12:10:00Z' }, now)).toBe(false);
  });
  it('available again once the hold expires', () => {
    expect(isAvailable({ status: 'reserved', reserved_until: '2026-06-02T11:50:00Z' }, now)).toBe(true);
  });
});
