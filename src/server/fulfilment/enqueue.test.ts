import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, processJob } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  processJob: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('./process-job', () => ({ processJob }));

import { enqueueProdigi } from './enqueue';

function makeEnv(send = vi.fn(async () => {})) {
  return { env: { PRODIGI_ENV: 'sandbox', FULFILMENT_QUEUE: { send } } as unknown as CloudflareEnv, send };
}

function setup(opts: {
  upsertRow?: { id: string } | null;
  upsertError?: { message: string } | null;
  existingRow?: { id: string } | null;
  selectError?: { message: string } | null;
}) {
  const calls = { upserts: [] as unknown[][] };
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'fulfilment_jobs') throw new Error(`unexpected table: ${table}`);
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
  return calls;
}

describe('enqueueProdigi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fresh order: upserts the job with a stable idempotency key and sends the queue message', async () => {
    const calls = setup({ upsertRow: { id: 'job-1' } });
    const { env, send } = makeEnv();
    const ctx = {} as ExecutionContext;

    await enqueueProdigi('ord-1', env, ctx);

    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0][0]).toMatchObject({
      order_id: 'ord-1',
      idempotency_key: 'prodigi:sandbox:order:ord-1:v1',
      status: 'queued',
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({ orderId: 'ord-1', jobId: 'job-1' });
  });

  it('duplicate webhook (idempotency-key conflict): recovers the existing job id and still sends', async () => {
    setup({ upsertRow: null, existingRow: { id: 'job-existing' } });
    const { env, send } = makeEnv();
    const ctx = {} as ExecutionContext;

    await enqueueProdigi('ord-1', env, ctx);

    // Same key → no second job row; the message re-sends for the ORIGINAL job
    // so a previously-failed send is retried, and processJob's claim makes a
    // duplicate delivery harmless.
    expect(send).toHaveBeenCalledExactlyOnceWith({ orderId: 'ord-1', jobId: 'job-existing' });
  });

  it('conflict path with a missing row → throws (Stripe must retry)', async () => {
    setup({ upsertRow: null, existingRow: null });
    const { env } = makeEnv();
    const ctx = {} as ExecutionContext;

    await expect(enqueueProdigi('ord-1', env, ctx)).rejects.toThrow(/job row missing/);
  });

  it('upsert failure → throws (Stripe must retry, fulfilment is never silently lost)', async () => {
    setup({ upsertError: { message: 'db down' } });
    const { env } = makeEnv();
    const ctx = {} as ExecutionContext;

    await expect(enqueueProdigi('ord-1', env, ctx)).rejects.toThrow(/job upsert failed/);
  });

  it('queue send failure → throws so the webhook 5xxes and Stripe redelivers', async () => {
    setup({ upsertRow: { id: 'job-1' } });
    const { env } = makeEnv(vi.fn(async () => { throw new Error('queue down'); }));
    const ctx = {} as ExecutionContext;

    await expect(enqueueProdigi('ord-1', env, ctx)).rejects.toThrow('queue down');
  });

  it('without FULFILMENT_QUEUE: schedules processJob via waitUntil and resolves (local dev path)', async () => {
    setup({ upsertRow: { id: 'job-1' } });
    const env = { PRODIGI_ENV: 'sandbox' } as unknown as CloudflareEnv;
    const waitUntil = vi.fn();
    const ctx = { waitUntil } as unknown as ExecutionContext;

    await expect(enqueueProdigi('ord-1', env, ctx)).resolves.toBeUndefined();

    expect(waitUntil).toHaveBeenCalledOnce();
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    expect(processJob).toHaveBeenCalledWith(
      { orderId: 'ord-1', jobId: 'job-1' },
      env,
      ctx,
    );
  });
});
