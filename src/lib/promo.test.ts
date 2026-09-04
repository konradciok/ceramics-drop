import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizePromoCode,
  checkPromoEligibility,
  computePromoDiscountMinor,
  fetchPromoByCode,
  getActiveNewsletterPromo,
  STRIPE_MIN_MINOR,
  type PromoCode,
} from './promo';

function mkPromo(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    code: 'WELCOME10',
    kind: 'percent',
    percent: 10,
    amount_pln: null,
    amount_eur: null,
    amount_gbp: null,
    applies_to: 'all',
    active: true,
    starts_at: null,
    expires_at: null,
    max_redemptions: null,
    newsletter_welcome: false,
    campaign: null,
    source: 'admin',
    source_order_id: null,
    ...overrides,
  };
}

describe('normalizePromoCode', () => {
  it('trims, uppercases, and accepts a well-formed code', () => {
    expect(normalizePromoCode('  welcome10 ')).toBe('WELCOME10');
  });
  it('accepts underscores and dashes at length boundaries', () => {
    expect(normalizePromoCode('a-b')).toBe('A-B'); // 3 chars, minimum
    expect(normalizePromoCode('x_'.repeat(16))).toBe('X_'.repeat(16)); // 32 chars, maximum
  });
  it('rejects empty and non-string input', () => {
    expect(normalizePromoCode('')).toBeNull();
    expect(normalizePromoCode('   ')).toBeNull();
    expect(normalizePromoCode(null)).toBeNull();
    expect(normalizePromoCode(undefined)).toBeNull();
    expect(normalizePromoCode(123)).toBeNull();
    expect(normalizePromoCode({})).toBeNull();
  });
  it('rejects codes outside the 3..32 length window', () => {
    expect(normalizePromoCode('ab')).toBeNull(); // 2 chars
    expect(normalizePromoCode('a'.repeat(33))).toBeNull(); // 33 chars
  });
  it('rejects interior spaces, diacritics, and emoji', () => {
    expect(normalizePromoCode('WEL COME')).toBeNull();
    expect(normalizePromoCode('zażółć')).toBeNull();
    expect(normalizePromoCode('SALE🔥10')).toBeNull();
  });
});

describe('checkPromoEligibility', () => {
  const now = new Date('2026-08-30T12:00:00Z');

  it('null promo -> not_found', () => {
    expect(checkPromoEligibility(null, 'ceramics', 0, now)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
  it('inactive promo -> inactive', () => {
    expect(checkPromoEligibility(mkPromo({ active: false }), 'ceramics', 0, now)).toEqual({
      ok: false,
      reason: 'inactive',
    });
  });
  it('starts_at in the future -> not_started', () => {
    const promo = mkPromo({ starts_at: '2026-09-01T00:00:00Z' });
    expect(checkPromoEligibility(promo, 'ceramics', 0, now)).toEqual({
      ok: false,
      reason: 'not_started',
    });
  });
  it('expires_at in the past -> expired', () => {
    const promo = mkPromo({ expires_at: '2026-08-01T00:00:00Z' });
    expect(checkPromoEligibility(promo, 'ceramics', 0, now)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
  it('expires_at === now -> expired (valid strictly while now < expires_at)', () => {
    const promo = mkPromo({ expires_at: now.toISOString() });
    expect(checkPromoEligibility(promo, 'ceramics', 0, now)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
  it('starts_at === now is already started', () => {
    const promo = mkPromo({ starts_at: now.toISOString() });
    expect(checkPromoEligibility(promo, 'ceramics', 0, now)).toEqual({ ok: true, promo });
  });
  it("applies_to 'ceramics' rejects the prints track", () => {
    const promo = mkPromo({ applies_to: 'ceramics' });
    expect(checkPromoEligibility(promo, 'prints', 0, now)).toEqual({
      ok: false,
      reason: 'wrong_track',
    });
    expect(checkPromoEligibility(promo, 'ceramics', 0, now)).toEqual({ ok: true, promo });
  });
  it("applies_to 'all' passes both tracks", () => {
    const promo = mkPromo({ applies_to: 'all' });
    expect(checkPromoEligibility(promo, 'ceramics', 0, now)).toEqual({ ok: true, promo });
    expect(checkPromoEligibility(promo, 'prints', 0, now)).toEqual({ ok: true, promo });
  });
  it('max_redemptions reached -> exhausted; below the cap passes', () => {
    const promo = mkPromo({ max_redemptions: 5 });
    expect(checkPromoEligibility(promo, 'ceramics', 5, now)).toEqual({
      ok: false,
      reason: 'exhausted',
    });
    expect(checkPromoEligibility(promo, 'ceramics', 4, now)).toEqual({ ok: true, promo });
  });
});

describe('STRIPE_MIN_MINOR', () => {
  it('carries the documented per-currency minimums', () => {
    expect(STRIPE_MIN_MINOR).toEqual({ pln: 200, eur: 50, gbp: 30 });
  });
});

describe('computePromoDiscountMinor', () => {
  it('percent: 10% of 57500 -> 5750', () => {
    const promo = mkPromo({ kind: 'percent', percent: 10 });
    expect(computePromoDiscountMinor(promo, 57500, 2000, 'pln')).toBe(5750);
  });
  it('percent: floors fractional results (15% of 999 -> 149)', () => {
    const promo = mkPromo({ kind: 'percent', percent: 15 });
    expect(computePromoDiscountMinor(promo, 999, 2000, 'pln')).toBe(149);
  });
  it('fixed: uses the per-currency amount', () => {
    const promo = mkPromo({
      kind: 'fixed',
      percent: null,
      amount_pln: 2000,
      amount_eur: 1000,
      amount_gbp: 800,
    });
    expect(computePromoDiscountMinor(promo, 57500, 500, 'eur')).toBe(1000);
  });
  it('fixed: clamps to the subtotal when the amount exceeds it', () => {
    const promo = mkPromo({
      kind: 'fixed',
      percent: null,
      amount_pln: 99999,
      amount_eur: 99999,
      amount_gbp: 99999,
    });
    // subtotal 5000, shipping 2000: subtotal clamp -> 5000; Stripe-min clamp
    // allows 5000 + 2000 - 200 = 6800, so subtotal is the binding clamp.
    expect(computePromoDiscountMinor(promo, 5000, 2000, 'pln')).toBe(5000);
  });
  it('Stripe-minimum clamp: 100% of 5000 with no shipping lands the charge on the minimum', () => {
    const promo = mkPromo({ kind: 'percent', percent: 100 });
    expect(computePromoDiscountMinor(promo, 5000, 0, 'pln')).toBe(4800); // charge = 200
  });
  it('Stripe-minimum clamp: shipping already covers the minimum, full discount stands', () => {
    const promo = mkPromo({ kind: 'percent', percent: 100 });
    expect(computePromoDiscountMinor(promo, 5000, 2000, 'pln')).toBe(5000);
  });
  it('undersized cart below the minimum keeps discount 0 (never negative, never a rejection)', () => {
    const promo = mkPromo({
      kind: 'fixed',
      percent: null,
      amount_pln: 1000,
      amount_eur: 1000,
      amount_gbp: 1000,
    });
    expect(computePromoDiscountMinor(promo, 150, 0, 'pln')).toBe(0);
  });
  it('always returns a non-negative integer', () => {
    const percent = mkPromo({ kind: 'percent', percent: 33 });
    for (const subtotal of [0, 1, 149, 5000, 57501]) {
      const d = computePromoDiscountMinor(percent, subtotal, 0, 'eur');
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });
  it('fixed with a missing per-currency amount yields 0', () => {
    const promo = mkPromo({ kind: 'fixed', percent: null, amount_pln: 2000 });
    expect(computePromoDiscountMinor(promo, 57500, 0, 'gbp')).toBe(0);
  });
});

/**
 * SupabaseClient-like stub: promo_codes lookup resolves `promoResult` via
 * .from('promo_codes').select().eq().maybeSingle(); the redemption count
 * resolves `countResult` via .from('promo_redemptions').select(head).eq().in()
 * (thenable chain, house stub style — see private-sale.test.ts).
 */
function supabaseStub(
  promoResult: { data: unknown; error: unknown },
  countResult: { count: number | null; error: unknown } = { count: 0, error: null },
) {
  const calls: Record<string, unknown> = {};
  const promoChain = {
    select: vi.fn(() => promoChain),
    eq: vi.fn((col: string, val: unknown) => {
      calls[`promo.eq:${col}`] = val;
      return promoChain;
    }),
    maybeSingle: vi.fn(async () => promoResult),
  };
  const countChain = {
    select: vi.fn(() => countChain),
    eq: vi.fn((col: string, val: unknown) => {
      calls[`count.eq:${col}`] = val;
      return countChain;
    }),
    in: vi.fn((col: string, val: unknown) => {
      calls[`count.in:${col}`] = val;
      return Promise.resolve(countResult);
    }),
  };
  const from = vi.fn((table: string) => (table === 'promo_codes' ? promoChain : countChain));
  return { client: { from } as unknown as SupabaseClient, from, calls };
}

describe('fetchPromoByCode', () => {
  it('returns the promo row and its live redemption count', async () => {
    const row = mkPromo({ code: 'WELCOME10' });
    const { client, from, calls } = supabaseStub({ data: row, error: null }, { count: 3, error: null });
    const result = await fetchPromoByCode(client, 'WELCOME10');
    expect(result.promo).toEqual(row);
    expect(result.redemptionCount).toBe(3);
    expect(from).toHaveBeenCalledWith('promo_codes');
    expect(from).toHaveBeenCalledWith('promo_redemptions');
    expect(calls['promo.eq:code']).toBe('WELCOME10');
    expect(calls['count.eq:promo_id']).toBe(row.id);
    expect(calls['count.in:status']).toEqual(['pending', 'redeemed']);
  });

  it('returns null promo and count 0 when the code is unknown', async () => {
    const { client, from } = supabaseStub({ data: null, error: null });
    const result = await fetchPromoByCode(client, 'NOPE99');
    expect(result).toEqual({ promo: null, redemptionCount: 0 });
    expect(from).not.toHaveBeenCalledWith('promo_redemptions');
  });
});

/** Stub for getActiveNewsletterPromo's .select().eq().eq().or().or().limit().maybeSingle() chain. */
function newsletterStub(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown> = {};
  const orFilters: string[] = [];
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((col: string, val: unknown) => {
      calls[`eq:${col}`] = val;
      return chain;
    }),
    or: vi.fn((filter: string) => {
      orFilters.push(filter);
      return chain;
    }),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => result),
  };
  const from = vi.fn(() => chain);
  return { client: { from } as unknown as SupabaseClient, from, calls, orFilters };
}

describe('getActiveNewsletterPromo', () => {
  it('returns the single active newsletter-flagged promo', async () => {
    const row = mkPromo({ newsletter_welcome: true });
    const { client, from, calls } = newsletterStub({ data: row, error: null });
    expect(await getActiveNewsletterPromo(client)).toEqual(row);
    expect(from).toHaveBeenCalledWith('promo_codes');
    expect(calls['eq:newsletter_welcome']).toBe(true);
    expect(calls['eq:active']).toBe(true);
  });

  it('filters out a not-yet-started or already-expired promo at the query level', async () => {
    const { client, orFilters } = newsletterStub({ data: null, error: null });
    await getActiveNewsletterPromo(client);
    // Same schedule window as checkPromoEligibility: starts_at in the past (or
    // absent) AND expires_at in the future (or absent).
    expect(orFilters).toHaveLength(2);
    expect(orFilters[0]).toMatch(/^starts_at\.is\.null,starts_at\.lte\./);
    expect(orFilters[1]).toMatch(/^expires_at\.is\.null,expires_at\.gt\./);
  });

  it('returns null when none is flagged', async () => {
    const { client } = newsletterStub({ data: null, error: null });
    expect(await getActiveNewsletterPromo(client)).toBeNull();
  });

  it('surfaces DB errors to the caller', async () => {
    const { client } = newsletterStub({ data: null, error: { message: 'db down' } });
    await expect(getActiveNewsletterPromo(client)).rejects.toThrow(/db down/);
  });
});
