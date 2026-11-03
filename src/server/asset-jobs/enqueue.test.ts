import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueAssetJob, sendAssetJobMessage, buildAssetJobIdempotencyKey } from './enqueue';

const UPLOAD_ID = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '22222222-2222-2222-2222-222222222222';

const JOB_ROW = {
  id: JOB_ID,
  upload_id: UPLOAD_ID,
  asset_id: null,
  asset_revision: 1,
  status: 'queued' as const,
  attempts: 0,
  idempotency_key: buildAssetJobIdempotencyKey(UPLOAD_ID),
  last_error: null,
  created_at: '2026-09-17T12:00:00.000Z',
  updated_at: '2026-09-17T12:00:00.000Z',
};

function setup(opts: {
  upsertRow?: typeof JOB_ROW | null;
  upsertError?: { message: string } | null;
  existingRow?: typeof JOB_ROW | null;
  selectError?: { message: string } | null;
}) {
  const mockFrom = vi.fn();
  const calls = { upserts: [] as unknown[][] };
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'print_asset_jobs') throw new Error(`unexpected table: ${table}`);
    return {
      upsert: (...args: unknown[]) => {
        calls.upserts.push(args);
        return {
          select: () => ({
            maybeSingle: async () => ({ data: opts.upsertRow ?? null, error: opts.upsertError ?? null }),
          }),
        };
      },
      select: () => ({
        eq: () => ({
          single: async () => ({ data: opts.existingRow ?? null, error: opts.selectError ?? null }),
        }),
      }),
    };
  });
  return { supabase: { from: mockFrom } as never, mockFrom, calls };
}

function makeEnv(send = vi.fn(async () => {})) {
  return { env: { ASSET_JOBS_QUEUE: { send } } as unknown as CloudflareEnv, send };
}

describe('buildAssetJobIdempotencyKey', () => {
  it('is deterministic per upload id', () => {
    expect(buildAssetJobIdempotencyKey(UPLOAD_ID)).toBe(buildAssetJobIdempotencyKey(UPLOAD_ID));
    expect(buildAssetJobIdempotencyKey(UPLOAD_ID)).toBe(`print-asset-job:${UPLOAD_ID}:v1`);
  });
});

describe('enqueueAssetJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fresh upload: upserts a queued job row and sends the queue message', async () => {
    const { supabase, calls } = setup({ upsertRow: JOB_ROW });
    const { env, send } = makeEnv();

    const job = await enqueueAssetJob(supabase, env, { uploadId: UPLOAD_ID, assetRevision: 1 });

    expect(job).toEqual(JOB_ROW);
    expect(calls.upserts).toHaveLength(1);
    const [payload, options] = calls.upserts[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(payload).toMatchObject({
      upload_id: UPLOAD_ID,
      asset_revision: 1,
      idempotency_key: buildAssetJobIdempotencyKey(UPLOAD_ID),
      status: 'queued',
    });
    expect(options).toMatchObject({ onConflict: 'idempotency_key', ignoreDuplicates: true });
    expect(send).toHaveBeenCalledWith({ jobId: JOB_ID, uploadId: UPLOAD_ID });
  });

  it('conflict (a job for this upload already exists): recovers the existing row and still sends the message', async () => {
    const { supabase } = setup({ upsertRow: null, existingRow: JOB_ROW });
    const { env, send } = makeEnv();

    const job = await enqueueAssetJob(supabase, env, { uploadId: UPLOAD_ID, assetRevision: 1 });

    expect(job).toEqual(JOB_ROW);
    expect(send).toHaveBeenCalledWith({ jobId: JOB_ID, uploadId: UPLOAD_ID });
  });

  it('throws when the upsert itself errors (not a conflict)', async () => {
    const { supabase } = setup({ upsertError: { message: 'boom' } });
    const { env } = makeEnv();

    await expect(enqueueAssetJob(supabase, env, { uploadId: UPLOAD_ID, assetRevision: 1 })).rejects.toThrow(/boom/);
  });

  it('throws when the conflict-recovery select finds nothing', async () => {
    const { supabase } = setup({ upsertRow: null, existingRow: null });
    const { env } = makeEnv();

    await expect(enqueueAssetJob(supabase, env, { uploadId: UPLOAD_ID, assetRevision: 1 })).rejects.toThrow(/missing after conflict/);
  });

  it('propagates a queue send failure', async () => {
    const { supabase } = setup({ upsertRow: JOB_ROW });
    const failingSend = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    const env = { ASSET_JOBS_QUEUE: { send: failingSend } } as unknown as CloudflareEnv;

    await expect(enqueueAssetJob(supabase, env, { uploadId: UPLOAD_ID, assetRevision: 1 })).rejects.toThrow(/queue unavailable/);
  });
});

describe('sendAssetJobMessage', () => {
  it('sends the exact {jobId, uploadId} message shape', async () => {
    const { env, send } = makeEnv();
    await sendAssetJobMessage(env, { jobId: JOB_ID, uploadId: UPLOAD_ID });
    expect(send).toHaveBeenCalledWith({ jobId: JOB_ID, uploadId: UPLOAD_ID });
  });

  it('throws (fails closed) when the ASSET_JOBS_QUEUE binding is missing', async () => {
    const env = {} as unknown as CloudflareEnv;
    await expect(sendAssetJobMessage(env, { jobId: JOB_ID, uploadId: UPLOAD_ID })).rejects.toThrow(/ASSET_JOBS_QUEUE/);
  });
});
