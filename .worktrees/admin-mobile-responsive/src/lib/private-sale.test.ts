import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizeToken,
  loadActivePrivateSale,
  INVALID_TOKEN_SENTINEL,
} from './private-sale';

/**
 * Builds a SupabaseClient-like stub whose query chain
 * (.from().select().eq().is().gt().maybeSingle()) resolves to `result`,
 * and records the filters applied so we can assert the active-sale guard.
 */
function supabaseStub(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown> = {};
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((col: string, val: unknown) => { calls[`eq:${col}`] = val; return chain; }),
    is: vi.fn((col: string, val: unknown) => { calls[`is:${col}`] = val; return chain; }),
    gt: vi.fn((col: string, val: unknown) => { calls[`gt:${col}`] = val; return chain; }),
    maybeSingle: vi.fn(async () => result),
  };
  const from = vi.fn(() => chain);
  return { client: { from } as unknown as SupabaseClient, from, chain, calls };
}

describe('normalizeToken', () => {
  it('trims a usable token', () => {
    expect(normalizeToken('  abc-123  ')).toBe('abc-123');
  });
  it('rejects non-strings, empty, and over-long tokens', () => {
    expect(normalizeToken(null)).toBeNull();
    expect(normalizeToken(123)).toBeNull();
    expect(normalizeToken('   ')).toBeNull();
    expect(normalizeToken('x'.repeat(129))).toBeNull();
  });
});

describe('INVALID_TOKEN_SENTINEL', () => {
  it('matches the value the RPC returns for a bad token', () => {
    expect(INVALID_TOKEN_SENTINEL).toBe('__invalid_token__');
  });
});

describe('loadActivePrivateSale', () => {
  it('returns the sale and only matches unconsumed, unexpired rows', async () => {
    const { client, from, calls } = supabaseStub({
      data: { id: 'ps_1', product_ids: ['k10', 't18'] },
      error: null,
    });
    const sale = await loadActivePrivateSale(client, 'tok');
    expect(sale).toEqual({ id: 'ps_1', product_ids: ['k10', 't18'] });
    expect(from).toHaveBeenCalledWith('private_sales');
    expect(calls['eq:token']).toBe('tok');
    expect(calls['is:consumed_at']).toBeNull(); // only unconsumed links
    expect(calls['gt:expires_at']).toBeTypeOf('string'); // only unexpired links
  });

  it('returns null when no row matches', async () => {
    const { client } = supabaseStub({ data: null, error: null });
    expect(await loadActivePrivateSale(client, 'tok')).toBeNull();
  });

  it('returns null on a query error', async () => {
    const { client } = supabaseStub({ data: null, error: { message: 'boom' } });
    expect(await loadActivePrivateSale(client, 'tok')).toBeNull();
  });

  it('returns null when the row has no product ids', async () => {
    const { client } = supabaseStub({ data: { id: 'ps_1', product_ids: [] }, error: null });
    expect(await loadActivePrivateSale(client, 'tok')).toBeNull();
  });
});
