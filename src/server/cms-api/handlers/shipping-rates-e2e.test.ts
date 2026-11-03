import { describe, expect, it, vi, beforeEach } from 'vitest';
import { shippingRatesGetRoute } from './shipping-rates-get';
import { shippingRatesSaveRoute } from './shipping-rates-save';
import { shippingRatesPublicationPostRoute } from './shipping-rates-publication';
import { shippingRatesRestorePostRoute } from './shipping-rates-restore';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import {
  SHIPPING_RATE_IDS,
  buildShippingRateFields,
  shippingRateFieldKeys,
  type ShippingRateId,
} from '../shipping-rates-mapping';
import { readShippingRates } from '@/lib/shipping-rates/load';
import { DEFAULT_DOMESTIC_SHIPPING } from '@/lib/pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING } from '@/lib/print-shipping';
import type { Field } from '../types';

// End-to-end: backfill -> get -> save -> publish -> restore, chained through the
// real route handlers and the real (unmocked) shipping-rates-mapping.ts /
// shipping-rates-validation.ts, against ONE stateful in-memory stand-in holding
// both shipping_rates rows and the shipping_rate_drafts table.
//
// The point is the thing per-handler tests cannot show: that publishing moves
// what src/lib/shipping-rates/load.ts — the module checkout prices from —
// actually returns, that saving and restoring do NOT, and that the two tracks
// are genuinely independent. The storefront side is exercised with the REAL
// readShippingRates against that same state, so the CMS write path and the
// checkout read path are proved to agree rather than asserted to.
//
// Docker is unreachable in this environment, so the RPCs themselves cannot run
// against real Postgres. runRpc below is a JS stand-in mirroring
// supabase/migrations/20260917150000_cms_api_shipping_rates.sql's documented
// behaviour — it drives a genuine revision/publish sequence; it is NOT a claim
// that the plpgsql is tested (that is the pgTAP suite's job, once a database is
// reachable).
vi.mock('../idempotency');

type RateRow = { id: ShippingRateId; published_revision: number | null };
type DraftRow = { rate_id: ShippingRateId; revision: number; payload: { fields: Field[] } };
type FakeState = { rates: RateRow[]; drafts: DraftRow[]; audit: Record<string, unknown>[] };

const CODE_RATES = { domestic: DEFAULT_DOMESTIC_SHIPPING, international: DEFAULT_INTERNATIONAL_SHIPPING };

/** Mirrors the migration: both rows created, revision 1 seeded from the code
 *  constants, published_revision stamped to 1, all in one step. */
function createBackfilledState(): FakeState {
  return {
    rates: SHIPPING_RATE_IDS.map((id) => ({ id, published_revision: 1 })),
    drafts: SHIPPING_RATE_IDS.map((id) => ({
      rate_id: id,
      revision: 1,
      payload: { fields: buildShippingRateFields(id, CODE_RATES) },
    })),
    audit: [],
  };
}

function maxRevision(state: FakeState, rateId: ShippingRateId): number {
  return state.drafts.reduce((max, d) => (d.rate_id === rateId ? Math.max(max, d.revision) : max), 0);
}

function rpcError(message: string, details?: string) {
  return { error: { message, details } };
}

/** The migration's publish-time range check, re-expressed in JS. */
function invalidKeys(rateId: ShippingRateId, fields: Field[]): string[] {
  const values: Record<string, string> = {};
  for (const f of fields) values[f.key] = f.value;
  const invalid: string[] = [];
  for (const key of shippingRateFieldKeys(rateId)) {
    const raw = (values[key] ?? '').trim();
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(raw)) {
      invalid.push(key);
      continue;
    }
    const n = Number(raw);
    const scaled = n * 100;
    if (n < 0 || Math.abs(scaled - Math.round(scaled)) > 1e-9) invalid.push(key);
  }
  return invalid;
}

function runRpc(state: FakeState, fn: string, args: Record<string, unknown>) {
  const rateId = args.p_rate_id as ShippingRateId;
  const row = state.rates.find((r) => r.id === rateId);
  if (!row) return rpcError('shipping_rate_not_found');
  const current = maxRevision(state, rateId);
  const expected = args.p_expected_revision as number;
  if (current !== expected) return rpcError('revision_conflict', `currentRevision=${current}`);

  switch (fn) {
    case 'save_shipping_rate_draft': {
      state.drafts.push({ rate_id: rateId, revision: current + 1, payload: args.p_payload as { fields: Field[] } });
      state.audit.push({ product_id: rateId, action: 'draft_saved', revision: current + 1 });
      return { error: null };
    }
    case 'publish_shipping_rate_revision': {
      if (expected === 0) return rpcError('draft_required');
      const draft = state.drafts.find((d) => d.rate_id === rateId && d.revision === expected);
      if (!draft) return rpcError('draft_required');
      const invalid = invalidKeys(rateId, draft.payload.fields);
      if (invalid.length > 0) return rpcError('shipping_rates_invalid', `invalidKeys=${invalid.join(',')}`);
      row.published_revision = expected;
      state.audit.push({ product_id: rateId, action: 'published', revision: expected });
      return { error: null };
    }
    case 'restore_shipping_rate_draft': {
      const source = state.drafts.find((d) => d.rate_id === rateId && d.revision === (args.p_source_revision as number));
      if (!source) return rpcError('source_revision_not_found');
      state.drafts.push({ rate_id: rateId, revision: current + 1, payload: source.payload });
      state.audit.push({ product_id: rateId, action: 'restored', revision: current + 1 });
      return { error: null };
    }
    default:
      throw new Error(`shipping-rates-e2e.test.ts: unmocked rpc "${fn}"`);
  }
}

/**
 * Covers both read shapes over these two tables: the CmsApi's
 * select/eq/order/limit/maybeSingle (shipping-rates-mapping.ts) AND the
 * storefront loader's select/in/abortSignal list read plus its
 * select/eq/eq/abortSignal/maybeSingle exact-revision read
 * (src/lib/shipping-rates/load.ts).
 */
function makeFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      if (table !== 'shipping_rates' && table !== 'shipping_rate_drafts') {
        throw new Error(`shipping-rates-e2e.test.ts: unmocked table "${table}"`);
      }
      const filters: Record<string, unknown> = {};

      const listResult = () => {
        const ids = (filters.id as string[]) ?? SHIPPING_RATE_IDS;
        return { data: state.rates.filter((r) => ids.includes(r.id)), error: null };
      };

      const singleResult = () => {
        if (table === 'shipping_rates') {
          const row = state.rates.find((r) => r.id === filters.id);
          return { data: row ? { published_revision: row.published_revision } : null, error: null };
        }
        const forRate = state.drafts.filter((d) => d.rate_id === filters.rate_id);
        const draft =
          filters.revision != null
            ? forRate.find((d) => d.revision === filters.revision)
            : [...forRate].sort((a, b) => b.revision - a.revision)[0];
        return { data: draft ? { revision: draft.revision, payload: draft.payload } : null, error: null };
      };

      const builder = {
        select: () => builder,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return builder;
        },
        in: (col: string, values: unknown) => {
          filters[col] = values;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => singleResult(),
        // The list read ends here (awaited directly); the exact-revision read
        // chains .maybeSingle() off it.
        abortSignal: () => Object.assign(Promise.resolve(listResult()), { maybeSingle: async () => singleResult() }),
      };
      return builder;
    },
  } as never;
}

function ctxWith(state: FakeState): HandlerContext {
  const supabase = makeFakeSupabase(state);
  return {
    actorEmail: 'anna@studio.pl',
    requestId: 'req_e2e',
    supabase: Object.assign(supabase as object, {
      rpc: (fn: string, args: Record<string, unknown>) => Promise.resolve(runRpc(state, fn, args)),
    }) as never,
  };
}

const env = {} as CloudflareEnv;

const get = (ctx: HandlerContext, id: ShippingRateId) =>
  shippingRatesGetRoute.handler(new Request(`https://x.test/v1/shipping-rates/${id}`), env, { id }, ctx);

const save = (ctx: HandlerContext, id: ShippingRateId, expectedRevision: number, fields: Field[]) =>
  shippingRatesSaveRoute.handler(
    new Request(`https://x.test/v1/shipping-rates/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision, name: 'ignorowana', fields }),
    }),
    env,
    { id },
    ctx,
  );

const publish = (ctx: HandlerContext, id: ShippingRateId, expectedRevision: number, key: string) =>
  shippingRatesPublicationPostRoute.handler(
    new Request(`https://x.test/v1/shipping-rates/${id}/publication`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ expectedRevision }),
    }),
    env,
    { id },
    ctx,
  );

const restore = (ctx: HandlerContext, id: ShippingRateId, expectedRevision: number, sourceRevision: number, key: string) =>
  shippingRatesRestorePostRoute.handler(
    new Request(`https://x.test/v1/shipping-rates/${id}/restore`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ expectedRevision, sourceRevision }),
    }),
    env,
    { id },
    ctx,
  );

function withValue(fields: Field[], key: string, value: string): Field[] {
  return fields.map((f) => (f.key === key ? { ...f, value } : f));
}

describe('shipping rates end-to-end: backfill -> get -> save -> publish -> restore', () => {
  let state: FakeState;
  let ctx: HandlerContext;

  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-e2e' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    state = createBackfilledState();
    ctx = ctxWith(state);
  });

  // The single most important property of the whole cutover: on day one, the
  // resource the CMS shows must be the values checkout is actually charging —
  // which, before the cutover, are the code constants themselves.
  it('DAY ONE: the backfilled revision 1 reads back through the checkout loader as exactly the code constants', async () => {
    for (const id of SHIPPING_RATE_IDS) {
      const res = await get(ctx, id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, kind: 'shipping-rates', revision: 1, publishedRevision: 1 });
    }

    const live = await readShippingRates(makeFakeSupabase(state));
    expect(live.domestic).toEqual(DEFAULT_DOMESTIC_SHIPPING);
    expect(live.international).toEqual(DEFAULT_INTERNATIONAL_SHIPPING);
  });

  it('chains save -> publish -> restore with revisions that genuinely accumulate (domestic)', async () => {
    const base = buildShippingRateFields('domestic', CODE_RATES);
    const raised = withValue(withValue(base, 'kurier_pln', '35'), 'paczkomat_eur', '6.5');

    // 1. save — revision 2. Checkout must not move: a draft is not a price.
    const saveRes = await save(ctx, 'domestic', 1, raised);
    expect(saveRes.status).toBe(200);
    expect((await saveRes.json()).revision).toBe(2);
    expect((await readShippingRates(makeFakeSupabase(state))).domestic.pln.kurier).toBe(30);

    // 2. publish — NOW the loader checkout prices from sees the new numbers.
    const publishRes = await publish(ctx, 'domestic', 2, 'pub-1');
    expect(publishRes.status).toBe(200);
    expect(await publishRes.json()).toMatchObject({ revision: 2, publishedRevision: 2 });
    const afterPublish = await readShippingRates(makeFakeSupabase(state));
    expect(afterPublish.domestic.pln.kurier).toBe(35);
    expect(afterPublish.domestic.eur.paczkomat).toBe(6.5);

    // 3. restore revision 1 — a NEW revision 3 carrying the old values, and the
    // published pointer (and therefore checkout) is untouched.
    const restoreRes = await restore(ctx, 'domestic', 2, 1, 'res-1');
    expect(restoreRes.status).toBe(200);
    const restored = await restoreRes.json();
    expect(restored.revision).toBe(3);
    expect(restored.publishedRevision).toBe(2);
    expect(restored.fields.find((f: Field) => f.key === 'kurier_pln').value).toBe('30');
    expect((await readShippingRates(makeFakeSupabase(state))).domestic.pln.kurier).toBe(35);

    expect(state.audit.map((a) => a.action)).toEqual(['draft_saved', 'published', 'restored']);
  });

  it('publishes the international track independently, without disturbing domestic', async () => {
    const intl = buildShippingRateFields('international', CODE_RATES);
    await save(ctx, 'international', 1, withValue(intl, 'gb_framed_eur', '24.5'));
    expect((await publish(ctx, 'international', 2, 'pub-intl')).status).toBe(200);

    const live = await readShippingRates(makeFakeSupabase(state));
    expect(live.international.GB.framed).toBe(24.5);
    expect(live.international.PL.framed).toBe(18.35);
    // Domestic is untouched, still on its own revision 1.
    expect(live.domestic).toEqual(DEFAULT_DOMESTIC_SHIPPING);
    expect(state.rates.find((r) => r.id === 'domestic')?.published_revision).toBe(1);
  });

  it('never lets an out-of-range draft reach the published pointer', async () => {
    const broken = withValue(buildShippingRateFields('domestic', CODE_RATES), 'kurier_gbp', '-1');
    expect((await save(ctx, 'domestic', 1, broken)).status).toBe(200); // saving a bad draft is allowed

    const publishRes = await publish(ctx, 'domestic', 2, 'pub-bad');
    expect(publishRes.status).toBe(422);
    expect((await publishRes.json()).fieldErrors).toHaveProperty('kurier_gbp');

    expect(state.rates.find((r) => r.id === 'domestic')?.published_revision).toBe(1);
    expect((await readShippingRates(makeFakeSupabase(state))).domestic.gbp.kurier).toBe(12);
  });

  it('rejects a third decimal place that toMinor() would silently round away, before it reaches checkout', async () => {
    const overPrecise = withValue(buildShippingRateFields('domestic', CODE_RATES), 'paczkomat_pln', '20.005');
    expect((await save(ctx, 'domestic', 1, overPrecise)).status).toBe(200);
    const publishRes = await publish(ctx, 'domestic', 2, 'pub-precision');
    expect(publishRes.status).toBe(422);
    expect((await publishRes.json()).fieldErrors).toHaveProperty('paczkomat_pln');
    expect((await readShippingRates(makeFakeSupabase(state))).domestic.pln.paczkomat).toBe(20);
  });

  it('409s a save against a stale revision', async () => {
    await save(ctx, 'domestic', 1, buildShippingRateFields('domestic', CODE_RATES));
    const stale = await save(ctx, 'domestic', 1, buildShippingRateFields('domestic', CODE_RATES));
    expect(stale.status).toBe(409);
    expect((await stale.json()).currentRevision).toBe(2);
  });

  it('carries no FX rate anywhere in either resource — the plan\'s named correctness hazard', async () => {
    for (const id of SHIPPING_RATE_IDS) {
      const resource = await (await get(ctx, id)).json();
      const keys = (resource.fields as Field[]).map((f) => f.key);
      expect(keys).not.toContain('eur_to_pln');
      expect(keys).not.toContain('eur_to_gbp');
    }
    const live = await readShippingRates(makeFakeSupabase(state));
    expect(JSON.stringify(live)).not.toMatch(/eurTo|eur_to/);
  });
});
