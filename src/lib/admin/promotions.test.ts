import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  listPromotions,
  createPromotion,
  updatePromotion,
  promoCreateSchema,
} from './promotions';
import type { PromoCode } from '@/lib/promo';

type Result = { data?: unknown; error?: unknown };

/**
 * Table-dispatching Supabase fake: each `from(table)` consumes the next
 * planned result for that table (the last one repeats). Every chained call is
 * recorded in `log` for payload/filter assertions. Chains are thenable and
 * expose maybeSingle, matching the repository's PostgREST usage.
 */
function fakeSupabase(plan: Record<string, Result[]>) {
  const log: Array<{ table: string; method: string; args: unknown[] }> = [];
  const supabase = {
    from(table: string) {
      const queue = plan[table] ?? [{ data: null, error: null }];
      const result = queue.length > 1 ? (queue.shift() as Result) : queue[0];
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'eq', 'in', 'order', 'limit', 'range']) {
        c[m] = (...args: unknown[]) => {
          log.push({ table, method: m, args });
          return c;
        };
      }
      c.maybeSingle = async () => result;
      c.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej);
      return c;
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, log };
}

const PROMO_ID = '11111111-2222-4333-8444-555555555555';
const promoRow = (overrides: Partial<PromoCode> = {}): PromoCode => ({
  id: PROMO_ID,
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
  ...overrides,
});

const validInput = {
  code: ' welcome10 ',
  kind: 'percent' as const,
  percent: 10,
  amount_pln: null,
  amount_eur: null,
  amount_gbp: null,
  applies_to: 'all' as const,
  starts_at: null,
  expires_at: null,
  max_redemptions: null,
  newsletter_welcome: false,
  campaign: null,
};

describe('promoCreateSchema cross-field refinement', () => {
  it('rejects percent kind without percent and fixed kind without all three amounts', () => {
    expect(promoCreateSchema.safeParse({ ...validInput, percent: null }).success).toBe(false);
    expect(
      promoCreateSchema.safeParse({
        ...validInput,
        kind: 'fixed',
        percent: null,
        amount_pln: 5000,
        amount_eur: null,
        amount_gbp: 1000,
      }).success,
    ).toBe(false);
    expect(
      promoCreateSchema.safeParse({
        ...validInput,
        kind: 'fixed',
        percent: null,
        amount_pln: 5000,
        amount_eur: 1200,
        amount_gbp: 1000,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty schedule window (starts_at >= expires_at)', () => {
    expect(
      promoCreateSchema.safeParse({
        ...validInput,
        starts_at: '2026-09-02T00:00:00Z',
        expires_at: '2026-09-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      promoCreateSchema.safeParse({
        ...validInput,
        starts_at: '2026-09-01T00:00:00Z',
        expires_at: '2026-09-02T00:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('rejects raw datetime-local strings (timezone-less)', () => {
    expect(
      promoCreateSchema.safeParse({ ...validInput, starts_at: '2026-09-01T12:00' }).success,
    ).toBe(false);
  });
});

describe('listPromotions', () => {
  it('returns promos with zeroed stats when nothing was redeemed', async () => {
    const { supabase } = fakeSupabase({
      promo_codes: [{ data: [promoRow()], error: null }],
      promo_redemptions: [{ data: [], error: null }],
      orders: [{ data: [], error: null }],
    });
    const out = await listPromotions(supabase);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('WELCOME10');
    expect(out[0].stats).toEqual({
      pending: 0,
      redeemed: 0,
      released: 0,
      discount_given_minor: { pln: 0, eur: 0, gbp: 0 },
      revenue_minor: { pln: 0, eur: 0, gbp: 0 },
      last_redeemed_at: null,
    });
  });

  it('aggregates redemption counts and per-currency order sums', async () => {
    const { supabase } = fakeSupabase({
      promo_codes: [{ data: [promoRow()], error: null }],
      promo_redemptions: [
        {
          data: [
            { promo_id: PROMO_ID, status: 'redeemed', settled_at: '2026-08-29T10:00:00Z' },
            { promo_id: PROMO_ID, status: 'redeemed', settled_at: '2026-08-30T10:00:00Z' },
            { promo_id: PROMO_ID, status: 'pending', settled_at: null },
            { promo_id: PROMO_ID, status: 'released', settled_at: '2026-08-28T10:00:00Z' },
            { promo_id: 'other-promo', status: 'redeemed', settled_at: '2026-08-30T12:00:00Z' },
          ],
          error: null,
        },
      ],
      orders: [
        {
          data: [
            { promo_code: 'WELCOME10', currency: 'pln', discount: 900, total: 8100 },
            { promo_code: 'WELCOME10', currency: 'pln', discount: 500, total: 4500 },
            { promo_code: 'WELCOME10', currency: 'eur', discount: 1000, total: 43000 },
            { promo_code: 'OTHER', currency: 'pln', discount: 100, total: 900 },
          ],
          error: null,
        },
      ],
    });
    const out = await listPromotions(supabase);
    expect(out[0].stats).toEqual({
      pending: 1,
      redeemed: 2,
      released: 1,
      discount_given_minor: { pln: 1400, eur: 1000, gbp: 0 },
      revenue_minor: { pln: 12600, eur: 43000, gbp: 0 },
      last_redeemed_at: '2026-08-30T10:00:00Z',
    });
  });

  it('throws on a query error', async () => {
    const { supabase } = fakeSupabase({
      promo_codes: [{ data: null, error: { message: 'db down' } }],
    });
    await expect(listPromotions(supabase)).rejects.toThrow(/db down/);
  });

  it('paginates past PostgREST max_rows (1000) instead of understating stats', async () => {
    // A full first page (1000 rows) must trigger a second `.range()` fetch —
    // otherwise a promo with >1000 lifetime redemptions/orders would silently
    // undercount (the bug CodeRabbit flagged on this function).
    const fullPage = Array.from({ length: 1000 }, () => ({
      promo_id: PROMO_ID,
      status: 'redeemed' as const,
      settled_at: '2026-08-29T10:00:00Z',
    }));
    const { supabase, log } = fakeSupabase({
      promo_codes: [{ data: [promoRow()], error: null }],
      promo_redemptions: [
        { data: fullPage, error: null },
        { data: [{ promo_id: PROMO_ID, status: 'redeemed', settled_at: '2026-08-30T10:00:00Z' }], error: null },
      ],
      orders: [{ data: [], error: null }],
    });
    const out = await listPromotions(supabase);
    expect(out[0].stats.redeemed).toBe(1001);
    expect(out[0].stats.last_redeemed_at).toBe('2026-08-30T10:00:00Z');
    const rangeCalls = log.filter((e) => e.table === 'promo_redemptions' && e.method === 'range');
    expect(rangeCalls.map((c) => c.args)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});

describe('createPromotion', () => {
  it('normalizes the code, inserts, audits, and returns 201', async () => {
    const inserted = promoRow({ active: false });
    const { supabase, log } = fakeSupabase({
      promo_codes: [{ data: inserted, error: null }],
      catalog_audit_log: [{ error: null }],
    });
    const res = await createPromotion(supabase, validInput, 'anna@studio.pl');
    expect(res.status).toBe(201);
    const insert = log.find((e) => e.table === 'promo_codes' && e.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ code: 'WELCOME10', kind: 'percent', percent: 10 });
    const audit = log.find((e) => e.table === 'catalog_audit_log' && e.method === 'insert');
    expect(audit?.args[0]).toMatchObject({
      product_id: 'promo:WELCOME10',
      action: 'promo:create',
      actor_email: 'anna@studio.pl',
      before: null,
    });
  });

  it('rejects an unnormalizable code with 400', async () => {
    const { supabase, log } = fakeSupabase({});
    const res = await createPromotion(supabase, { ...validInput, code: 'zażółć' }, null);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_code' });
    expect(log.find((e) => e.method === 'insert')).toBeUndefined();
  });

  it('maps a duplicate-code 23505 to 409 code_exists', async () => {
    const { supabase } = fakeSupabase({
      promo_codes: [
        { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "promo_codes_code_key"' } },
      ],
    });
    const res = await createPromotion(supabase, validInput, null);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'code_exists' });
  });

  it('maps the newsletter partial-unique-index 23505 to 409 newsletter_welcome_taken', async () => {
    const { supabase } = fakeSupabase({
      promo_codes: [
        { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "promo_codes_one_newsletter_welcome"' } },
      ],
    });
    const res = await createPromotion(supabase, { ...validInput, newsletter_welcome: true }, null);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'newsletter_welcome_taken' });
  });
});

describe('updatePromotion', () => {
  it('a bare { active } toggle on a valid stored row passes and audits', async () => {
    const current = promoRow({ active: false });
    const after = promoRow({ active: true });
    const { supabase, log } = fakeSupabase({
      promo_codes: [
        { data: current, error: null }, // load current
        { data: after, error: null },   // update result
      ],
      catalog_audit_log: [{ error: null }],
    });
    const res = await updatePromotion(supabase, PROMO_ID, { active: true }, 'anna@studio.pl');
    expect(res.status).toBe(200);
    const update = log.find((e) => e.table === 'promo_codes' && e.method === 'update');
    expect(update?.args[0]).toMatchObject({ active: true, updated_by: 'anna@studio.pl' });
    const audit = log.find((e) => e.table === 'catalog_audit_log' && e.method === 'insert');
    expect(audit?.args[0]).toMatchObject({
      product_id: 'promo:WELCOME10',
      action: 'promo:update',
      before: current,
      after,
    });
  });

  it('rejects any attempt to change code with 400 code_immutable', async () => {
    const { supabase, log } = fakeSupabase({});
    const res = await updatePromotion(supabase, PROMO_ID, { code: 'NEWCODE' } as never, null);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'code_immutable' });
    expect(log.find((e) => e.method === 'update')).toBeUndefined();
  });

  it('validates the MERGED record: kind→fixed without stored amounts is rejected', async () => {
    const { supabase, log } = fakeSupabase({
      promo_codes: [{ data: promoRow(), error: null }], // stored percent promo, no amounts
    });
    const res = await updatePromotion(supabase, PROMO_ID, { kind: 'fixed' }, null);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'validation_failed' });
    expect(log.find((e) => e.method === 'update')).toBeUndefined();
  });

  it('kind→fixed passes when the stored row already carries all three amounts', async () => {
    const stored = promoRow({ amount_pln: 5000, amount_eur: 1200, amount_gbp: 1000 });
    const after = { ...stored, kind: 'fixed', percent: null };
    const { supabase } = fakeSupabase({
      promo_codes: [
        { data: stored, error: null },
        { data: after, error: null },
      ],
      catalog_audit_log: [{ error: null }],
    });
    const res = await updatePromotion(supabase, PROMO_ID, { kind: 'fixed', percent: null }, null);
    expect(res.status).toBe(200);
  });

  it('rejects a merged empty schedule window', async () => {
    const stored = promoRow({ starts_at: '2026-09-02T00:00:00Z' });
    const { supabase } = fakeSupabase({
      promo_codes: [{ data: stored, error: null }],
    });
    const res = await updatePromotion(supabase, PROMO_ID, { expires_at: '2026-09-01T00:00:00Z' }, null);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'validation_failed' });
  });

  it('404s when the promotion does not exist', async () => {
    const { supabase } = fakeSupabase({
      promo_codes: [{ data: null, error: null }],
    });
    const res = await updatePromotion(supabase, PROMO_ID, { active: true }, null);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('maps the newsletter unique-index 23505 on activation to 409', async () => {
    const stored = promoRow({ newsletter_welcome: true, active: false });
    const { supabase } = fakeSupabase({
      promo_codes: [
        { data: stored, error: null },
        { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "promo_codes_one_newsletter_welcome"' } },
      ],
    });
    const res = await updatePromotion(supabase, PROMO_ID, { active: true }, null);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'newsletter_welcome_taken' });
  });
});
