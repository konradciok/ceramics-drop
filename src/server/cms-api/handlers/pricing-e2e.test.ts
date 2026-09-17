import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pricingGetRoute } from './pricing-get';
import { pricingSaveRoute } from './pricing-save';
import { pricingPublicationPostRoute } from './pricing-publication';
import { pricingRestorePostRoute } from './pricing-restore';
import { pricingPreviewPostRoute } from './pricing-preview';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import { PRICING_RESOURCE_ID, buildPricingFields } from '../pricing-mapping';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import { readPrintPricingConfig, updatePrintPricingConfig } from '@/lib/print-pricing-config/repository';
import type { Field } from '../types';

// End-to-end: backfill -> get -> save -> preview -> publish -> restore, chained
// through the real route handlers and the real (unmocked) pricing-mapping.ts /
// pricing-validation.ts, against ONE stateful in-memory stand-in holding both
// the live print_pricing_config row and the pricing_config_drafts table.
//
// The point is the thing per-handler tests cannot show: that publishing moves
// the LIVE SINGLETON ROW — the row checkout reads directly through
// src/lib/print-pricing-config/repository.ts — and that saving and restoring do
// not. Step 6 of the plan's cutover ("run the CmsApi path in parallel with the
// still-live legacy panel only long enough to integration-test") is exercised
// here by driving the legacy writer (updatePrintPricingConfig) against the very
// same state, unmodified.
//
// Docker is unreachable in this environment, so the RPCs themselves cannot run
// against real Postgres. runRpc below is a JS stand-in mirroring
// supabase/migrations/20260917140000_cms_api_pricing.sql's documented behaviour
// — it drives a genuine revision/publish sequence; it is NOT a claim that the
// plpgsql is tested (that is the pgTAP suite's job, once a database is
// reachable).
vi.mock('../idempotency');

type LiveRow = {
  id: true;
  base_30x40_eur: number;
  base_50x70_eur: number;
  base_70x100_eur: number;
  frame_30x40_eur: number;
  frame_50x70_eur: number;
  frame_70x100_eur: number;
  mount_30x40_eur: number;
  mount_50x70_eur: number;
  mount_70x100_eur: number;
  eur_to_pln: number;
  eur_to_gbp: number;
  published_revision: number | null;
  updated_at: string;
  updated_by: string | null;
};

type DraftRow = { revision: number; payload: { fields: Field[] } };

type FakeState = { live: LiveRow | null; drafts: DraftRow[]; audit: Record<string, unknown>[] };

const EUR_KEYS = [
  'base_30x40_eur',
  'base_50x70_eur',
  'base_70x100_eur',
  'frame_30x40_eur',
  'frame_50x70_eur',
  'frame_70x100_eur',
  'mount_30x40_eur',
  'mount_50x70_eur',
  'mount_70x100_eur',
] as const;

/**
 * Mirrors the migration exactly: the live row is seeded from
 * DEFAULT_PRINT_PRICING (the documented twin of 20260807120000's seed row),
 * pricing_config_drafts revision 1 is built FROM that live row, and
 * published_revision is stamped to 1 in the same step.
 */
function createBackfilledState(): FakeState {
  const d = DEFAULT_PRINT_PRICING;
  const live: LiveRow = {
    id: true,
    base_30x40_eur: d.baseEur['30x40'],
    base_50x70_eur: d.baseEur['50x70'],
    base_70x100_eur: d.baseEur['70x100'],
    frame_30x40_eur: d.frameEur['30x40'],
    frame_50x70_eur: d.frameEur['50x70'],
    frame_70x100_eur: d.frameEur['70x100'],
    mount_30x40_eur: d.mountEur['30x40'],
    mount_50x70_eur: d.mountEur['50x70'],
    mount_70x100_eur: d.mountEur['70x100'],
    eur_to_pln: d.eurToPln,
    eur_to_gbp: d.eurToGbp,
    published_revision: 1,
    updated_at: '2026-08-07T00:00:00.000Z',
    updated_by: null,
  };
  return { live, drafts: [{ revision: 1, payload: { fields: buildPricingFields(d) } }], audit: [] };
}

function maxRevision(state: FakeState): number {
  return state.drafts.reduce((max, d) => Math.max(max, d.revision), 0);
}

function rpcError(message: string, details?: string) {
  return { error: { message, details } };
}

function fieldValues(fields: Field[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.key] = f.value;
  return out;
}

/** The migration's publish-time range check, re-expressed in JS. */
function invalidKeys(values: Record<string, string>): string[] {
  const invalid: string[] = [];
  for (const key of EUR_KEYS) {
    const raw = (values[key] ?? '').trim();
    if (!/^-?[0-9]+$/.test(raw)) {
      invalid.push(key);
      continue;
    }
    const n = Number(raw);
    if (key.startsWith('base_') ? n <= 0 : n < 0) invalid.push(key);
  }
  for (const key of ['eur_to_pln', 'eur_to_gbp'] as const) {
    const raw = (values[key] ?? '').trim();
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(raw)) {
      invalid.push(key);
      continue;
    }
    const n = Number(raw);
    const scale = raw.includes('.') ? raw.split('.')[1].length : 0;
    if (n <= 0 || n > 100 || scale > 4) invalid.push(key);
  }
  return invalid;
}

function runRpc(state: FakeState, fn: string, args: Record<string, unknown>) {
  if (!state.live) return rpcError('pricing_config_missing');
  const current = maxRevision(state);
  const expected = args.p_expected_revision as number;

  switch (fn) {
    case 'save_pricing_draft': {
      if (current !== expected) return rpcError('revision_conflict', `currentRevision=${current}`);
      state.drafts.push({ revision: current + 1, payload: args.p_payload as { fields: Field[] } });
      state.audit.push({ product_id: 'print-pricing', action: 'draft_saved', revision: current + 1 });
      return { error: null };
    }
    case 'publish_pricing_revision': {
      if (current !== expected) return rpcError('revision_conflict', `currentRevision=${current}`);
      if (expected === 0) return rpcError('draft_required');
      const draft = state.drafts.find((d) => d.revision === expected);
      if (!draft) return rpcError('draft_required');

      const values = fieldValues(draft.payload.fields);
      const invalid = invalidKeys(values);
      if (invalid.length > 0) return rpcError('pricing_invalid', `invalidKeys=${invalid.join(',')}`);

      for (const key of EUR_KEYS) state.live![key] = Number(values[key]);
      state.live!.eur_to_pln = Number(values.eur_to_pln);
      state.live!.eur_to_gbp = Number(values.eur_to_gbp);
      state.live!.published_revision = expected;
      state.live!.updated_by = args.p_actor_email as string;
      state.audit.push({ product_id: 'print-pricing', action: 'published', revision: expected });
      return { error: null };
    }
    case 'restore_pricing_draft': {
      if (current !== expected) return rpcError('revision_conflict', `currentRevision=${current}`);
      const source = state.drafts.find((d) => d.revision === (args.p_source_revision as number));
      if (!source) return rpcError('source_revision_not_found');
      state.drafts.push({ revision: current + 1, payload: source.payload });
      state.audit.push({ product_id: 'print-pricing', action: 'restored', revision: current + 1 });
      return { error: null };
    }
    default:
      throw new Error(`pricing-e2e.test.ts: unmocked rpc "${fn}"`);
  }
}

/**
 * Covers both surfaces that touch these tables: pricing-mapping.ts's
 * select/order/limit/maybeSingle reads, AND the LEGACY writer's
 * select('*')/abortSignal()/update()/eq()/insert() chain in
 * src/lib/print-pricing-config/repository.ts — deliberately, so the legacy
 * panel and the CmsApi can be driven against one shared state.
 */
function makeFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      if (table === 'catalog_audit_log') {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.audit.push(row);
            return { error: null };
          },
        };
      }
      const rowFor = () => {
        if (table === 'print_pricing_config') return state.live;
        if (table === 'pricing_config_drafts') {
          return [...state.drafts].sort((a, b) => b.revision - a.revision)[0] ?? null;
        }
        throw new Error(`pricing-e2e.test.ts: unmocked table "${table}"`);
      };
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: () => builder,
        abortSignal: () => builder,
        maybeSingle: async () => ({ data: rowFor(), error: null }),
      };
      return {
        ...builder,
        update: (patch: Record<string, unknown>) => {
          Object.assign(state.live as LiveRow, patch);
          return builder;
        },
      };
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

const params = { id: PRICING_RESOURCE_ID };
const env = {} as CloudflareEnv;

const get = (ctx: HandlerContext) =>
  pricingGetRoute.handler(new Request('https://x.test/v1/pricing/print-pricing'), env, params, ctx);

const save = (ctx: HandlerContext, expectedRevision: number, fields: Field[]) =>
  pricingSaveRoute.handler(
    new Request('https://x.test/v1/pricing/print-pricing', {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision, name: 'Cennik Fine Art Print', fields }),
    }),
    env,
    params,
    ctx,
  );

const publish = (ctx: HandlerContext, expectedRevision: number, key: string) =>
  pricingPublicationPostRoute.handler(
    new Request('https://x.test/v1/pricing/print-pricing/publication', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ expectedRevision }),
    }),
    env,
    params,
    ctx,
  );

const restore = (ctx: HandlerContext, expectedRevision: number, sourceRevision: number, key: string) =>
  pricingRestorePostRoute.handler(
    new Request('https://x.test/v1/pricing/print-pricing/restore', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ expectedRevision, sourceRevision }),
    }),
    env,
    params,
    ctx,
  );

const previewAt = (ctx: HandlerContext, expectedRevision: number, fields: Field[]) =>
  pricingPreviewPostRoute.handler(
    new Request('https://x.test/v1/pricing/print-pricing/preview', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, fields }),
    }),
    env,
    params,
    ctx,
  );

function withValue(fields: Field[], key: string, value: string): Field[] {
  return fields.map((f) => (f.key === key ? { ...f, value } : f));
}

describe('pricing end-to-end: backfill -> get -> save -> preview -> publish -> restore', () => {
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
  // resource the CMS shows must be the values checkout is actually charging.
  it('DAY ONE: the backfilled revision 1 matches what the legacy read path returns from the live row', async () => {
    const res = await get(ctx);
    expect(res.status).toBe(200);
    const resource = await res.json();
    expect(resource).toMatchObject({ id: 'print-pricing', kind: 'pricing', revision: 1, publishedRevision: 1 });

    const live = await readPrintPricingConfig(makeFakeSupabase(state));
    const byKey = Object.fromEntries((resource.fields as Field[]).map((f) => [f.key, f.value]));
    expect(byKey).toEqual({
      base_30x40_eur: String(live.baseEur['30x40']),
      base_50x70_eur: String(live.baseEur['50x70']),
      base_70x100_eur: String(live.baseEur['70x100']),
      frame_30x40_eur: String(live.frameEur['30x40']),
      frame_50x70_eur: String(live.frameEur['50x70']),
      frame_70x100_eur: String(live.frameEur['70x100']),
      mount_30x40_eur: String(live.mountEur['30x40']),
      mount_50x70_eur: String(live.mountEur['50x70']),
      mount_70x100_eur: String(live.mountEur['70x100']),
      eur_to_pln: String(live.eurToPln),
      eur_to_gbp: String(live.eurToGbp),
    });
  });

  it('chains save -> preview -> publish -> restore with revisions that genuinely accumulate', async () => {
    const base = buildPricingFields(DEFAULT_PRINT_PRICING);
    const raised = withValue(withValue(base, 'base_30x40_eur', '40'), 'eur_to_pln', '4.3');

    // 1. save — revision 2. The LIVE row must not move: a draft is not a price.
    const saveRes = await save(ctx, 1, raised);
    expect(saveRes.status).toBe(200);
    expect((await saveRes.json()).revision).toBe(2);
    expect(state.live?.base_30x40_eur).toBe(25);
    expect(state.live?.published_revision).toBe(1);
    expect((await readPrintPricingConfig(makeFakeSupabase(state))).baseEur['30x40']).toBe(25);

    // 2. preview at the new revision — 27 items, computed from the CANDIDATE
    // values in the request body, still without touching the live row.
    const previewRes = await previewAt(ctx, 2, raised);
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.items).toHaveLength(27);
    const baseEurItem = preview.items.find((i: { label: string; currency: string }) => i.label === 'Baza 30 × 40 cm' && i.currency === 'EUR');
    // 40 EUR; PLN = round(40 x 4.3 / 5) x 5 = 170
    expect(baseEurItem.minorUnits).toBe(4000);
    const basePlnItem = preview.items.find((i: { label: string; currency: string }) => i.label === 'Baza 30 × 40 cm' && i.currency === 'PLN');
    expect(basePlnItem.minorUnits).toBe(17000);
    expect(state.live?.base_30x40_eur).toBe(25);

    // 3. publish — NOW the live row moves, atomically, and the legacy read
    // path (the one checkout uses) sees the new numbers.
    const publishRes = await publish(ctx, 2, 'pub-1');
    expect(publishRes.status).toBe(200);
    expect((await publishRes.json())).toMatchObject({ revision: 2, publishedRevision: 2 });
    const afterPublish = await readPrintPricingConfig(makeFakeSupabase(state));
    expect(afterPublish.baseEur['30x40']).toBe(40);
    expect(afterPublish.eurToPln).toBe(4.3);
    expect(state.live?.updated_by).toBe('anna@studio.pl');

    // 4. restore revision 1 — a NEW revision 3 carrying the old values, and
    // the live row (and therefore checkout) is untouched: restoring is not
    // publishing.
    const restoreRes = await restore(ctx, 2, 1, 'res-1');
    expect(restoreRes.status).toBe(200);
    const restored = await restoreRes.json();
    expect(restored.revision).toBe(3);
    expect(restored.publishedRevision).toBe(2);
    expect(restored.fields.find((f: Field) => f.key === 'base_30x40_eur').value).toBe('25');
    expect((await readPrintPricingConfig(makeFakeSupabase(state))).baseEur['30x40']).toBe(40);

    expect(state.audit.map((a) => a.action)).toEqual(['draft_saved', 'published', 'restored']);
  });

  it('never lets an out-of-range draft reach the live row', async () => {
    const broken = withValue(buildPricingFields(DEFAULT_PRINT_PRICING), 'base_50x70_eur', '0');
    expect((await save(ctx, 1, broken)).status).toBe(200); // saving a bad draft is allowed

    const publishRes = await publish(ctx, 2, 'pub-bad');
    expect(publishRes.status).toBe(422);
    expect((await publishRes.json()).fieldErrors).toHaveProperty('base_50x70_eur');

    expect(state.live?.base_50x70_eur).toBe(50);
    expect(state.live?.published_revision).toBe(1);
  });

  it('rejects a 5-decimal FX rate that numeric(8,4) would silently round, before it reaches the live row', async () => {
    const overPrecise = withValue(buildPricingFields(DEFAULT_PRINT_PRICING), 'eur_to_pln', '4.25005');
    expect((await save(ctx, 1, overPrecise)).status).toBe(200);
    const publishRes = await publish(ctx, 2, 'pub-precision');
    expect(publishRes.status).toBe(422);
    expect((await publishRes.json()).fieldErrors).toHaveProperty('eur_to_pln');
    expect(state.live?.eur_to_pln).toBe(4.25);
  });

  // Why cutover steps 7-8 exist, demonstrated rather than asserted in prose.
  // updatePrintPricingConfig is the OLD direct writer: it is no longer on any
  // production write path (the admin panel is read-only as of step 7, and
  // /api/admin/print-pricing now goes through save_pricing_draft +
  // publish_pricing_revision as of step 8), and this is the concrete damage it
  // would do if it were still live alongside the CmsApi — published_revision
  // left pointing at a draft whose values are no longer the live ones, so the
  // CMS shows one price and checkout charges another.
  it('two-writer hazard: the retired direct writer desynchronises published_revision from the live values', async () => {
    await save(ctx, 1, withValue(buildPricingFields(DEFAULT_PRINT_PRICING), 'base_30x40_eur', '40'));
    await publish(ctx, 2, 'pub-1');
    expect(state.live?.published_revision).toBe(2);
    expect(state.live?.base_30x40_eur).toBe(40);

    // The legacy, non-versioned writer — unmodified, exactly as
    // /api/admin/print-pricing calls it today.
    await updatePrintPricingConfig(
      makeFakeSupabase(state),
      { ...DEFAULT_PRINT_PRICING, baseEur: { ...DEFAULT_PRINT_PRICING.baseEur, '30x40': 99 } },
      'legacy@studio.pl',
    );

    expect(state.live?.base_30x40_eur).toBe(99);
    // published_revision still says "revision 2", but revision 2's payload
    // says 40. The CMS would show 40 while checkout charges 99.
    expect(state.live?.published_revision).toBe(2);
    const resource = await (await get(ctx)).json();
    expect(resource.fields.find((f: Field) => f.key === 'base_30x40_eur').value).toBe('40');
  });
});
