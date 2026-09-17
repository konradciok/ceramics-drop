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
const MSG = { jobId: JOB_ID, uploadId: UPLOAD_ID };
const ENV_BASE = {} as CloudflareEnv;
const CTX = {} as ExecutionContext;

const CONFIRMED_UPLOAD = { id: UPLOAD_ID, status: 'confirmed', r2_key: `uploads/${UPLOAD_ID}.jpg` };

/** Builds a thenable Supabase-query-builder-like chain (mirrors
 *  fulfilment/process-job.test.ts's makeChain helper). Every chained method
 *  returns the same chain object; awaiting it resolves to `result`, unless a
 *  method name is overridden to resolve to something else. */
function makeChain(result: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
  };
  for (const m of ['update', 'eq', 'in', 'select']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  Object.assign(chain, overrides);
  return chain;
}

function setup(opts: {
  claimResult: { data: unknown; error: unknown };
  uploadResult?: { data: unknown; error: unknown };
  finalizeResult?: { data: unknown; error: unknown };
  failResult?: { data: unknown; error: unknown };
}) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  let updateCallCount = 0;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'print_asset_jobs') {
      return {
        update: (payload: Record<string, unknown>) => {
          updateCallCount += 1;
          calls.push({ table, op: 'update', payload });
          // 1st update = claim; 2nd (only reached on the happy path or a
          // failJob call) = finalize/fail.
          if (updateCallCount === 1) {
            return makeChain(undefined, { select: () => makeChain(undefined, { maybeSingle: async () => opts.claimResult }) });
          }
          if (payload.status === 'completed') {
            return makeChain(undefined, {
              select: () => makeChain(undefined, { maybeSingle: async () => opts.finalizeResult ?? { data: { id: JOB_ID }, error: null } }),
            });
          }
          return makeChain(opts.failResult ?? { data: null, error: null });
        },
      };
    }
    if (table === 'print_asset_uploads') {
      return {
        select: () => makeChain(undefined, { eq: () => makeChain(undefined, { maybeSingle: async () => opts.uploadResult }) }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return { calls };
}

describe('processAssetJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claim miss (already terminal / duplicate delivery): returns without touching the upload table', async () => {
    setup({ claimResult: { data: null, error: null } });
    await processAssetJob(MSG, ENV_BASE, CTX);
    expect(mockFrom).toHaveBeenCalledTimes(1); // only the claim update — no upload lookup
  });

  it('claim error: throws so the queue retries', async () => {
    setup({ claimResult: { data: null, error: { message: 'db down' } } });
    await expect(processAssetJob(MSG, ENV_BASE, CTX)).rejects.toBeTruthy();
  });

  it('upload row missing: fails the job as failed_action_required (no throw — no queue retry) AND fires a synchronous alert', async () => {
    const { calls } = setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: null, error: null },
    });
    await expect(processAssetJob(MSG, ENV_BASE, CTX)).resolves.toBeUndefined();
    const failCall = calls.find((c) => c.op === 'update' && (c.payload as Record<string, unknown>).status === 'failed_action_required');
    expect(failCall).toBeTruthy();
    expect((failCall!.payload as Record<string, unknown>).last_error).toMatch(new RegExp(UPLOAD_ID));

    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      ENV_BASE,
      expect.objectContaining({
        message: 'asset_job_failed_action_required',
        level: 'error',
        extra: expect.objectContaining({
          jobId: JOB_ID,
          uploadId: UPLOAD_ID,
          lastError: expect.stringMatching(new RegExp(UPLOAD_ID)),
          attempts: 1,
        }),
      }),
    );
  });

  it('upload not confirmed: fails the job as failed_action_required AND fires a synchronous alert', async () => {
    setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: { ...CONFIRMED_UPLOAD, status: 'pending' }, error: null },
    });
    await expect(processAssetJob(MSG, ENV_BASE, CTX)).resolves.toBeUndefined();
    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      ENV_BASE,
      expect.objectContaining({
        message: 'asset_job_failed_action_required',
        extra: expect.objectContaining({ jobId: JOB_ID, uploadId: UPLOAD_ID, lastError: expect.stringMatching(/not confirmed/) }),
      }),
    );
  });

  it('upload lookup errors: throws so the queue retries', async () => {
    setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: null, error: { message: 'transient' } },
    });
    await expect(processAssetJob(MSG, ENV_BASE, CTX)).rejects.toBeTruthy();
  });

  it('PRINT_ASSETS binding missing: fails the job as failed_action_required, no throw, AND fires a synchronous alert', async () => {
    setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
    });
    await expect(processAssetJob(MSG, ENV_BASE, CTX)).resolves.toBeUndefined();
    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      ENV_BASE,
      expect.objectContaining({
        message: 'asset_job_failed_action_required',
        extra: expect.objectContaining({ jobId: JOB_ID, uploadId: UPLOAD_ID, lastError: expect.stringMatching(/PRINT_ASSETS/) }),
      }),
    );
  });

  it('R2 object missing: fails the job as failed_action_required, no throw, AND fires a synchronous alert', async () => {
    setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
    });
    const env = { PRINT_ASSETS: { head: vi.fn().mockResolvedValue(null) } } as unknown as CloudflareEnv;
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    expect(mockCaptureAlert).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        message: 'asset_job_failed_action_required',
        extra: expect.objectContaining({ jobId: JOB_ID, uploadId: UPLOAD_ID, lastError: expect.stringMatching(/R2 object missing/) }),
      }),
    );
  });

  it('R2 head throws: marks failed_retryable AND rethrows so the queue retries, and does NOT fire the failed_action_required alert', async () => {
    const { calls } = setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
    });
    const env = {
      PRINT_ASSETS: { head: vi.fn().mockRejectedValue(new Error('R2 down')) },
    } as unknown as CloudflareEnv;
    await expect(processAssetJob(MSG, env, CTX)).rejects.toThrow(/R2 down/);
    const failCall = calls.find((c) => c.op === 'update' && (c.payload as Record<string, unknown>).status === 'failed_retryable');
    expect(failCall).toBeTruthy();
    // failed_retryable already gets its normal chance to retry/backoff/DLQ
    // through the existing queue machinery — it must not ALSO alert here.
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it('happy path (stub success): claims, verifies the upload + R2 object, then marks completed — no Sharp, no asset_id, no alert', async () => {
    const { calls } = setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
      finalizeResult: { data: { id: JOB_ID }, error: null },
    });
    const env = { PRINT_ASSETS: { head: vi.fn().mockResolvedValue({ size: 1000 }) } } as unknown as CloudflareEnv;
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
    const completeCall = calls.find((c) => c.op === 'update' && (c.payload as Record<string, unknown>).status === 'completed');
    expect(completeCall).toBeTruthy();
    expect(completeCall!.payload).not.toHaveProperty('asset_id');
    expect((completeCall!.payload as Record<string, unknown>).attempts).toBe(1);
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it('finalize CAS loses the race (concurrent delivery finalized it first): does not throw', async () => {
    setup({
      claimResult: { data: { attempts: 0 }, error: null },
      uploadResult: { data: CONFIRMED_UPLOAD, error: null },
      finalizeResult: { data: null, error: null },
    });
    const env = { PRINT_ASSETS: { head: vi.fn().mockResolvedValue({ size: 1000 }) } } as unknown as CloudflareEnv;
    await expect(processAssetJob(MSG, env, CTX)).resolves.toBeUndefined();
  });
});
