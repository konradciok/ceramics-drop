import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));

import { enqueueProdigi } from './enqueue';

const CTX = {} as ExecutionContext;

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

    await enqueueProdigi('ord-1', env, CTX);

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

    await enqueueProdigi('ord-1', env, CTX);

    // Same key → no second job row; the message re-sends for the ORIGINAL job
    // so a previously-failed send is retried, and processJob's claim makes a
    // duplicate delivery harmless.
    expect(send).toHaveBeenCalledExactlyOnceWith({ orderId: 'ord-1', jobId: 'job-existing' });
  });

  it('conflict path with a missing row → throws (Stripe must retry)', async () => {
    setup({ upsertRow: null, existingRow: null });
    const { env } = makeEnv();

    await expect(enqueueProdigi('ord-1', env, CTX)).rejects.toThrow(/job row missing/);
  });

  it('upsert failure → throws (Stripe must retry, fulfilment is never silently lost)', async () => {
    setup({ upsertError: { message: 'db down' } });
    const { env } = makeEnv();

    await expect(enqueueProdigi('ord-1', env, CTX)).rejects.toThrow(/job upsert failed/);
  });

  it('queue send failure → throws so the webhook 5xxes and Stripe redelivers', async () => {
    setup({ upsertRow: { id: 'job-1' } });
    const { env } = makeEnv(vi.fn(async () => { throw new Error('queue down'); }));

    await expect(enqueueProdigi('ord-1', env, CTX)).rejects.toThrow('queue down');
  });
});
