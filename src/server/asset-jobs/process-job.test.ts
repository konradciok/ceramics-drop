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

import { processAssetJob, isAssetJobsQueue } from './process-job';
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
 *  method name is overridden to resolve to something else. */
function makeChain(result: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
  };
  for (const m of ['update', 'upsert', 'eq', 'in', 'select']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  Object.assign(chain, overrides);
  return chain;
}

type SetupOptions = {
  claimResult?: { data: unknown; error: unknown };
  uploadResult?: { data: unknown; error: unknown };
  productResult?: { data: unknown; error: unknown };
  variantsResult?: { data: unknown; error: unknown };
  stageResult?: { data: unknown; error: unknown };
  readBackResult?: { data: unknown; error: unknown };
  finalizeResult?: { data: unknown; error: unknown };
};

function setup(opts: SetupOptions) {
  const calls: { table: string; op: string; payload?: unknown; options?: unknown }[] = [];
  let jobUpdateCount = 0;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'print_asset_jobs') {
      return {
        update: (payload: Record<string, unknown>) => {
          jobUpdateCount += 1;
          calls.push({ table, op: 'update', payload });
          // 1st update = claim; later ones = finalize (status 'completed') or fail.
          if (jobUpdateCount === 1) {
            return makeChain(undefined, {
              select: () => makeChain(undefined, { maybeSingle: async () => opts.claimResult ?? { data: { attempts: 0 }, error: null } }),
            });
          }
          if (payload.status === 'completed') {
            return makeChain(undefined, {
              select: () => makeChain(undefined, { maybeSingle: async () => opts.finalizeResult ?? { data: { id: JOB_ID }, error: null } }),
            });
          }
          return makeChain({ data: null, error: null });
        },
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

  return { calls };
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

  it('claim miss (already terminal / duplicate delivery): returns without touching the upload table', async () => {
    setup({ claimResult: { data: null, error: null } });
    await processAssetJob(MSG, makeEnv(), CTX);
    expect(mockFrom).toHaveBeenCalledTimes(1); // only the claim update — no upload lookup
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
