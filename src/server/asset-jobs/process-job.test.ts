import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockCaptureAlert } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCaptureAlert: vi.fn(async (...args: unknown[]) => { void args; }),
}));

// C-2 guard (mirrors src/server/fulfilment/process-job.test.ts): the queue
// consumer runs OUTSIDE the request ALS, so getSupabaseAdmin() (which
// resolves getCloudflareContext()) would throw there. Mock it to throw and
// provide the env-based client instead — processAssetJob must build its
// client via supabaseFromEnv(env), the SAME pattern the existing fulfilment
// queue consumer uses (this repo's only precedent for "how does a queue
// consumer get its Supabase client").
vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: () => ({ from: mockFrom }),
  getSupabaseAdmin: () => {
    throw new Error('getCloudflareContext outside ALS');
  },
}));
vi.mock('@/lib/worker-sentry', () => ({ captureWorkerAlert: mockCaptureAlert }));

import { processAssetJob, isAssetJobsQueue, JOB_DEADLINE_MS } from './process-job';
import type { RenderResult } from './container-render';

describe('isAssetJobsQueue', () => {
  it('matches the production and preview primary queue names', () => {
    expect(isAssetJobsQueue('print-asset-jobs')).toBe(true);
    expect(isAssetJobsQueue('print-asset-jobs-preview')).toBe(true);
  });

  it('matches both DLQ variants', () => {
    expect(isAssetJobsQueue('print-asset-jobs-dlq')).toBe(true);
    expect(isAssetJobsQueue('print-asset-jobs-preview-dlq')).toBe(true);
  });

  it('never matches the unrelated fulfilment queue names', () => {
    expect(isAssetJobsQueue('prodigi-fulfilment')).toBe(false);
    expect(isAssetJobsQueue('prodigi-fulfilment-dlq')).toBe(false);
  });
});

const JOB_ID = '22222222-2222-2222-2222-222222222222';
const UPLOAD_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = 'print-001';
const REVISION = `cms-${UPLOAD_ID}`;
const ASSET_ID = '33333333-3333-3333-3333-333333333333';
const SHA = 'c'.repeat(64);
const R2_KEY = `prints/${PRODUCT_ID}/${REVISION}/3600x4800-${SHA}.jpg`;
const MSG = { jobId: JOB_ID, uploadId: UPLOAD_ID };
const CTX = {} as ExecutionContext;

const CONFIRMED_UPLOAD = {
  id: UPLOAD_ID,
  status: 'confirmed',
  r2_key: `uploads/${UPLOAD_ID}.jpg`,
  ratio: '3x4',
  content_type: 'image/jpeg',
  product_id: PRODUCT_ID,
};

const ACTIVE_VARIANTS = [
  { variant_key: '30x40:false:false:black', print_area_width_px: 3600, print_area_height_px: 4800 },
];

const OK_RESULT: RenderResult = {
  kind: 'ok',
  asset: {
    product_id: PRODUCT_ID,
    revision: REVISION,
    profile_key: '3600x4800',
    r2_key: R2_KEY,
    sha256: SHA,
    content_type: 'image/jpeg',
    width_px: 3600,
    height_px: 4800,
    byte_size: 4242,
    status: 'staged',
  },
};

/** Builds a thenable Supabase-query-builder-like chain (mirrors
 *  fulfilment/process-job.test.ts's makeChain helper). Every chained method
 *  returns the same chain object; awaiting it resolves to `result`, unless a
 *  method name is overridden to resolve to something else.
 *  `orLog`, if given, records every `.or(filter)` call's filter string —
 *  Finding 1's claim query is the only caller of `.or()` in this file, so
 *  tests use it to assert the exact OR-filter shape without pinning the
 *  whole query builder. */
function makeChain(result: unknown, overrides: Record<string, unknown> = {}, orLog?: string[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
  };
  for (const m of ['update', 'upsert', 'eq', 'in', 'select']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.or = vi.fn((filter: string) => {
    orLog?.push(filter);
    return chain;
  });
  Object.assign(chain, overrides);
  return chain;
}

type SetupOptions = {
  claimResult?: { data: unknown; error: unknown };
  /** The status-lookup fired ONLY when the claim misses (Finding 1's
   *  terminal-vs-active-lease disposition check). Defaults to 'completed' —
   *  i.e. "the claim missed because the job is already done", the ordinary
   *  duplicate-delivery case. */
  claimMissLookupResult?: { data: unknown; error: unknown };
  uploadResult?: { data: unknown; error: unknown };
  productResult?: { data: unknown; error: unknown };
  variantsResult?: { data: unknown; error: unknown };
  stageResult?: { data: unknown; error: unknown };
  readBackResult?: { data: unknown; error: unknown };
  finalizeResult?: { data: unknown; error: unknown };
  /** The `failJob(...)` write's own CAS result (lease_token fencing). Defaults
   *  to "matched" — a normal, non-fenced failure write. */
  failResult?: { data: unknown; error: unknown };
};

function setup(opts: SetupOptions) {
  const calls: { table: string; op: string; payload?: unknown; options?: unknown }[] = [];
  const orFilters: string[] = [];
  let jobUpdateCount = 0;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'print_asset_jobs') {
      return {
        update: (payload: Record<string, unknown>) => {
          jobUpdateCount += 1;
          calls.push({ table, op: 'update', payload });
          // 1st update = claim; later ones = finalize (status 'completed') or fail.
          if (jobUpdateCount === 1) {
            return makeChain(
              undefined,
              { select: () => makeChain(undefined, { maybeSingle: async () => opts.claimResult ?? { data: { attempts: 0 }, error: null } }) },
              orFilters,
            );
          }
          if (payload.status === 'completed') {
            return makeChain(undefined, {
              select: () => makeChain(undefined, { maybeSingle: async () => opts.finalizeResult ?? { data: { id: JOB_ID }, error: null } }),
            });
          }
          // A fail write (failed_retryable / failed_action_required) — also
          // CAS'd on lease_token now (Finding 1), so it needs the same
          // select().maybeSingle() tail as claim/finalize.
          return makeChain(undefined, {
            select: () => makeChain(undefined, { maybeSingle: async () => opts.failResult ?? { data: { id: JOB_ID }, error: null } }),
          });
        },
        // The claim-miss status lookup (`.select('status').eq('id', jobId).maybeSingle()`).
        select: () =>
          makeChain(undefined, {
            eq: () =>
              makeChain(undefined, {
                maybeSingle: async () => opts.claimMissLookupResult ?? { data: { status: 'completed' }, error: null },
              }),
          }),
      };
    }
    if (table === 'print_asset_uploads') {
      return { select: () => makeChain(undefined, { eq: () => makeChain(undefined, { maybeSingle: async () => opts.uploadResult }) }) };
    }
    if (table === 'products') {
      return {
        select: () => makeChain(undefined, {
          eq: () => makeChain(undefined, { maybeSingle: async () => opts.productResult ?? { data: { status: 'active' }, error: null } }),
        }),
      };
    }
    if (table === 'product_variants') {
      return { select: () => makeChain(opts.variantsResult ?? { data: ACTIVE_VARIANTS, error: null }) };
    }
    if (table === 'print_fulfilment_assets') {
      return {
        upsert: (payload: unknown, options: unknown) => {
          calls.push({ table, op: 'upsert', payload, options });
          return makeChain(opts.stageResult ?? { data: null, error: null });
        },
        select: () => makeChain(undefined, {
          in: () => makeChain(opts.readBackResult ?? { data: [{ id: ASSET_ID, r2_key: R2_KEY }], error: null }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return { calls, orFilters };
}

function makeEnv(opts: { head?: unknown; render?: (input: unknown) => Promise<RenderResult>; processor?: unknown } = {}): CloudflareEnv {
  const renderDerivative = vi.fn(opts.render ?? (async () => OK_RESULT));
  const processor = 'processor' in opts ? opts.processor : { getByName: () => ({ renderDerivative }) };
  return {
    PRINT_ASSETS: { head: vi.fn().mockResolvedValue(opts.head === undefined ? { size: 1000 } : opts.head) },
    PRINT_ASSET_PROCESSOR: processor,
  } as unknown as CloudflareEnv;
}

/** Pulls the renderDerivative spy back out of an env built by makeEnv. */
function renderSpy(env: CloudflareEnv) {
  return (env.PRINT_ASSET_PROCESSOR as unknown as { getByName: () => { renderDerivative: ReturnType<typeof vi.fn> } })
    .getByName().renderDerivative;
}

function failCall(calls: { op: string; payload?: unknown }[], status: string) {
  return calls.find((c) => c.op === 'update' && (c.payload as Record<string, unknown>)?.status === status);
}

describe('processAssetJob — Task 10 claim/fail/finalize machinery (unchanged by Phase 3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claim miss, row is terminal (already completed / duplicate delivery): returns without touching the upload table', async () => {
    setup({ claimResult: { data: null, error: null }, claimMissLookupResult: { data: { status: 'completed' }, error: null } });
    await processAssetJob(MSG, makeEnv(), CTX);
    // claim update + the Finding-1 status lookup that classifies the miss — still no upload lookup.
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('claim miss, row is genuinely gone (no row found by the status lookup): returns without touching the upload table', async () => {
    setup({ claimResult: { data: null, error: null }, claimMissLookupResult: { data: null, error: null } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).resolves.toBeUndefined();
  });

  it('claim error: throws so the queue retries', async () => {
    setup({ claimResult: { data: null, error: { message: 'db down' } } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).rejects.toBeTruthy();
  });

  it('upload row missing: fails as failed_action_required (no throw) AND fires a synchronous alert', async () => {
    const { calls } = setup({ uploadResult: { data: null, error: null } });
    const env = makeEnv();
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    expect((failCall(calls, 'failed_action_required')!.payload as Record<string, unknown>).last_error).toMatch(new RegExp(UPLOAD_ID));
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        message: 'asset_job_failed_action_required',
        level: 'error',
        extra: expect.objectContaining({ jobId: JOB_ID, uploadId: UPLOAD_ID, attempts: 1 }),
      }),
    );
  });

  it('upload not confirmed: fails as failed_action_required', async () => {
    setup({ uploadResult: { data: { ...CONFIRMED_UPLOAD, status: 'pending' }, error: null } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).resolves.toBeUndefined();
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extra: expect.objectContaining({ lastError: expect.stringMatching(/not confirmed/) }) }),
    );
  });

  it('upload lookup errors: throws so the queue retries', async () => {
    setup({ uploadResult: { data: null, error: { message: 'transient' } } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).rejects.toBeTruthy();
  });

  it('R2 head throws: marks failed_retryable AND rethrows, without firing the action-required alert', async () => {
    const { calls } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv();
    (env.PRINT_ASSETS.head as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('R2 down'));
    await expect(processAssetJob(MSG, env, CTX)).rejects.toThrow(/R2 down/);
    expect(failCall(calls, 'failed_retryable')).toBeTruthy();
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it('R2 object missing: fails as failed_action_required without waking the container', async () => {
    setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv({ head: null });
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    expect(renderSpy(env)).not.toHaveBeenCalled();
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ extra: expect.objectContaining({ lastError: expect.stringMatching(/R2 object missing/) }) }),
    );
  });
});

describe('processAssetJob — Phase 3 container processing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: renders every profile, stages the assets, then completes with asset_id set', async () => {
    const { calls } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv();
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();

    expect(renderSpy(env)).toHaveBeenCalledTimes(1);
    expect(renderSpy(env)).toHaveBeenCalledWith({
      jobId: JOB_ID,
      uploadId: UPLOAD_ID,
      productId: PRODUCT_ID,
      revision: REVISION,
      sourceKey: CONFIRMED_UPLOAD.r2_key,
      sourceContentType: 'image/jpeg',
      expectedRatio: '3x4',
      target: { w: 3600, h: 4800 },
      format: 'jpg',
      deadlineMs: expect.any(Number), // Finding 2: the job-wide render deadline
    });

    const upsert = calls.find((c) => c.op === 'upsert');
    expect(upsert!.payload).toEqual([OK_RESULT.kind === 'ok' ? OK_RESULT.asset : null]);
    // Never an UPDATE: an asset already promoted past `staged` would be
    // rejected by guard_print_asset_immutable if this wrote it back down.
    expect(upsert!.options).toEqual({ onConflict: 'r2_key', ignoreDuplicates: true });

    const complete = failCall(calls, 'completed')!;
    expect(complete.payload).toMatchObject({ status: 'completed', asset_id: ASSET_ID, attempts: 1 });
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it('renders one derivative per distinct profile, sequentially', async () => {
    const order: string[] = [];
    setup({
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
      variantsResult: {
        data: [
          { variant_key: '30x40:false:false:black', print_area_width_px: 3600, print_area_height_px: 4800 },
          { variant_key: '50x70:false:false:black', print_area_width_px: 5400, print_area_height_px: 7200 },
          // Shares the first profile — one derivative serves both variants.
          { variant_key: '30x40:true:false:white', print_area_width_px: 3600, print_area_height_px: 4800 },
        ],
        error: null,
      },
      readBackResult: {
        data: [
          { id: ASSET_ID, r2_key: R2_KEY },
          { id: '44444444-4444-4444-4444-444444444444', r2_key: `${R2_KEY}-2` },
        ],
        error: null,
      },
    });
    const env = makeEnv({
      render: async (input) => {
        const target = (input as { target: { w: number; h: number } }).target;
        order.push(`${target.w}x${target.h}`);
        if (OK_RESULT.kind !== 'ok') throw new Error('unreachable');
        return order.length === 1
          ? OK_RESULT
          : { kind: 'ok', asset: { ...OK_RESULT.asset, r2_key: `${R2_KEY}-2`, profile_key: '5400x7200' } };
      },
    });

    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    // distinctProfiles sorts by profileKey — deterministic order, two profiles
    // for three variants.
    expect(order).toEqual(['3600x4800', '5400x7200']);
  });

  it('upload with no product_id: fails as failed_action_required rather than "completing" with nothing', async () => {
    const { calls } = setup({ uploadResult: { data: { ...CONFIRMED_UPLOAD, product_id: null }, error: null } });
    const env = makeEnv();
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    expect((failCall(calls, 'failed_action_required')!.payload as Record<string, unknown>).last_error).toMatch(/no product_id/);
    expect(renderSpy(env)).not.toHaveBeenCalled();
  });

  it('upload with an unknown ratio: fails as failed_action_required', async () => {
    const { calls } = setup({ uploadResult: { data: { ...CONFIRMED_UPLOAD, ratio: 'A4' }, error: null } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).resolves.toBeUndefined();
    expect((failCall(calls, 'failed_action_required')!.payload as Record<string, unknown>).last_error).toMatch(/unknown ratio/);
  });

  it('missing PRINT_ASSETS binding: fails as failed_action_required', async () => {
    setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    await expect(processAssetJob(MSG, {} as CloudflareEnv, CTX)).resolves.toBeUndefined();
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extra: expect.objectContaining({ lastError: expect.stringMatching(/PRINT_ASSETS/) }) }),
    );
  });

  it('missing PRINT_ASSET_PROCESSOR container binding: fails as failed_action_required, never crashes the consumer', async () => {
    setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv({ processor: undefined });
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ extra: expect.objectContaining({ lastError: expect.stringMatching(/PRINT_ASSET_PROCESSOR/) }) }),
    );
  });

  it('non-active product: fails as failed_action_required without waking the container', async () => {
    setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null }, productResult: { data: { status: 'draft' }, error: null } });
    const env = makeEnv();
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    expect(renderSpy(env)).not.toHaveBeenCalled();
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ extra: expect.objectContaining({ lastError: expect.stringMatching(/is not active/) }) }),
    );
  });

  it('a permanent container failure ends the job terminally (no throw, no retry)', async () => {
    const { calls } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv({ render: async () => ({ kind: 'permanent', code: 'WOULD_UPSCALE', message: 'too small' }) });
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    const fail = failCall(calls, 'failed_action_required')!;
    expect((fail.payload as Record<string, unknown>).last_error).toMatch(/3600x4800: WOULD_UPSCALE — too small/);
    expect(calls.find((c) => c.op === 'upsert')).toBeUndefined();
  });

  it('a retryable container failure marks failed_retryable AND rethrows so Task 10 backoff/DLQ applies', async () => {
    const { calls } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv({ render: async () => ({ kind: 'retryable', code: 'CONTAINER_NOT_READY', message: 'cold' }) });
    await expect(processAssetJob(MSG, env, CTX)).rejects.toThrow(/CONTAINER_NOT_READY/);
    expect(failCall(calls, 'failed_retryable')).toBeTruthy();
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it('an RPC-level throw from the container DO marks failed_retryable AND rethrows', async () => {
    const { calls } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv({
      render: async () => {
        throw new Error('durable object reset');
      },
    });
    await expect(processAssetJob(MSG, env, CTX)).rejects.toThrow(/durable object reset/);
    expect(failCall(calls, 'failed_retryable')).toBeTruthy();
  });

  it('a staging-write error throws so the queue retries — never finalizes a job with no assets behind it', async () => {
    setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null }, stageResult: { data: null, error: { message: 'db down' } } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).rejects.toBeTruthy();
  });

  it('staged rows missing on read-back: failed_retryable + rethrow rather than a completed job with a null asset', async () => {
    const { calls } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null }, readBackResult: { data: [], error: null } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).rejects.toThrow(/missing after upsert/);
    expect(failCall(calls, 'failed_retryable')).toBeTruthy();
    expect(failCall(calls, 'completed')).toBeUndefined();
  });

  it('finalize CAS loses the race (a concurrent delivery finalized it first): does not throw', async () => {
    setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null }, finalizeResult: { data: null, error: null } });
    await expect(processAssetJob(MSG, makeEnv(), CTX)).resolves.toBeUndefined();
  });
});

// ── Task G (CodeRabbit PR #318 round 2): Finding 1 (lease + fencing) and
// Finding 2 (job-wide render deadline) regression coverage ──────────────────
describe('processAssetJob — Finding 1: claim lease + fencing token', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the claim query only reclaims `processing` when its lease has EXPIRED — an active lease is not reclaimed, and the miss is retried rather than acked', async () => {
    const { orFilters } = setup({
      claimResult: { data: null, error: null }, // the (mocked) DB correctly excluded the still-active-lease row
      claimMissLookupResult: { data: { status: 'processing' }, error: null }, // ...because it is still processing
    });
    // Throws (not resolves): acking here would permanently drop the message —
    // if the active-lease holder actually crashed, nothing would ever arrive
    // to reclaim the row once its lease genuinely expires (see the inline
    // comment on this branch in process-job.ts). Throwing makes worker.ts
    // retry with backoff instead.
    await expect(processAssetJob(MSG, makeEnv(), CTX)).rejects.toThrow(/lease.*active/i);

    // The claim query's OR filter is what actually encodes "processing is
    // claimable ONLY with an expired lease" — asserted here so a regression
    // that drops the `and(...)` clause (making `processing` unconditionally
    // claimable again, like before this fix) fails this test even though the
    // mock's claimResult is hardcoded.
    expect(orFilters).toHaveLength(1);
    expect(orFilters[0]).toContain('status.eq.queued');
    expect(orFilters[0]).toContain('status.eq.failed_retryable');
    expect(orFilters[0]).toMatch(/and\(status\.eq\.processing,lease_expires_at\.lt\.[^,)]+\)/);
  });

  it('an expired lease IS reclaimed: the claim succeeds and mints a fresh lease_token + lease_expires_at in the SAME update', async () => {
    const { calls, orFilters } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv();
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();

    // Same OR-filter shape as the active-lease test above — this time the
    // (mocked) DB is presumed to have matched it because the lease had
    // expired; the filter text itself doesn't change between the two cases,
    // only whether a real Postgres would match it.
    expect(orFilters[0]).toMatch(/and\(status\.eq\.processing,lease_expires_at\.lt\.[^,)]+\)/);

    const claim = failCall(calls, 'processing')!; // the claim update itself sets status: 'processing'
    const payload = claim.payload as Record<string, unknown>;
    expect(payload.lease_token).toEqual(expect.any(String));
    expect(payload.lease_expires_at).toEqual(expect.any(String));
    // A real UUID, not a placeholder — crypto.randomUUID()'s shape.
    expect(payload.lease_token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('fencing: a failJob write whose lease_token no longer matches the row (reclaimed by a second worker) is a no-op, not a corrupting write', async () => {
    const { calls } = setup({
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
      // Simulates a second worker having already reclaimed this row (a fresh
      // lease_token) by the time THIS worker's failJob write reaches the DB —
      // the update's `.eq('lease_token', ourToken)` predicate matches 0 rows.
      failResult: { data: null, error: null },
    });
    const env = makeEnv({ render: async () => ({ kind: 'permanent', code: 'WOULD_UPSCALE', message: 'too small' }) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The permanent-result branch still returns normally — failJob's own
    // fencing no-op does not surface as a throw or a rejected promise; it is
    // silently absorbed exactly like the existing finalize-race tolerance.
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();

    // The write was attempted (the call is recorded)...
    expect(failCall(calls, 'failed_action_required')).toBeTruthy();
    // ...but because it was fenced out, the action-required alert — which
    // would misattribute this job's outcome to a worker that no longer owns
    // it — must NOT fire.
    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no-op.*lease_token/));

    warnSpy.mockRestore();
  });
});

describe('processAssetJob — Finding 2: job-wide render deadline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a profile whose remaining job-wide budget is already exhausted fails CONTAINER_TIMEOUT/retryable WITHOUT ever calling the container', async () => {
    const { calls } = setup({ uploadResult: { data: CONFIRMED_UPLOAD, error: null } });
    const env = makeEnv();

    // Date.now() is called exactly three times before the loop's first
    // pre-check in this single-profile fixture: (1) computing lease_expires_at
    // at claim time, (2) computing the job-wide `deadlineMs` right before the
    // loop, (3) the loop's own remaining-budget check for the first (only)
    // profile. Returning the SAME instant for (1)-(2) and an instant well past
    // JOB_DEADLINE_MS for (3) simulates "the deadline was already exceeded by
    // the time the loop re-checked it" without waiting 12 real minutes.
    const baseTime = 1_800_000_000_000;
    let dateNowCalls = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      dateNowCalls += 1;
      return dateNowCalls <= 2 ? baseTime : baseTime + JOB_DEADLINE_MS + 1;
    });

    try {
      await expect(processAssetJob(MSG, env, CTX)).rejects.toThrow(/CONTAINER_TIMEOUT/);
    } finally {
      dateSpy.mockRestore();
    }

    expect(renderSpy(env)).not.toHaveBeenCalled(); // the container RPC was never made
    const fail = failCall(calls, 'failed_retryable')!;
    expect((fail.payload as Record<string, unknown>).last_error).toMatch(/CONTAINER_TIMEOUT/);
    expect(mockCaptureAlert).not.toHaveBeenCalled(); // failed_retryable never alerts synchronously
  });

  it('a profile with budget remaining is still handed the SAME job-wide deadlineMs — not a fresh per-profile one', async () => {
    const { calls } = setup({
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
      variantsResult: {
        data: [
          { variant_key: '30x40:false:false:black', print_area_width_px: 3600, print_area_height_px: 4800 },
          { variant_key: '50x70:false:false:black', print_area_width_px: 5400, print_area_height_px: 7200 },
        ],
        error: null,
      },
      readBackResult: {
        data: [
          { id: ASSET_ID, r2_key: R2_KEY },
          { id: '44444444-4444-4444-4444-444444444444', r2_key: `${R2_KEY}-2` },
        ],
        error: null,
      },
    });
    const seenDeadlines: number[] = [];
    const env = makeEnv({
      render: async (input) => {
        seenDeadlines.push((input as { deadlineMs: number }).deadlineMs);
        if (OK_RESULT.kind !== 'ok') throw new Error('unreachable');
        return seenDeadlines.length === 1
          ? OK_RESULT
          : { kind: 'ok', asset: { ...OK_RESULT.asset, r2_key: `${R2_KEY}-2`, profile_key: '5400x7200' } };
      },
    });

    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    expect(calls.find((c) => c.op === 'update' && (c.payload as Record<string, unknown>)?.status === 'completed')).toBeTruthy();
    expect(seenDeadlines).toHaveLength(2);
    expect(seenDeadlines[0]).toBe(seenDeadlines[1]); // same absolute deadline, not re-derived per profile
  });
});
