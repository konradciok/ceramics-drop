import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, processJob } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  processJob: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('./process-job', () => ({ processJob }));

import { enqueueProdigi, parseEnvFromIdempotencyKey } from './enqueue';

function makeEnv(send = vi.fn(async () => {}), prodigiEnv = 'sandbox') {
  return { env: { PRODIGI_ENV: prodigiEnv, FULFILMENT_QUEUE: { send } } as unknown as CloudflareEnv, send };
}

function setup(opts: {
  upsertRow?: { id: string } | null;
  upsertError?: { message: string; code?: string; details?: string } | null;
  existingRow?: { id: string } | null;
  selectError?: { message: string } | null;
  /** Row returned by the env-flip classification select (active job for the order). */
  activeRow?: Record<string, unknown> | null;
  /** Rows returned by the park UPDATE's select (empty = CAS lost). */
  parkedRows?: unknown[];
}) {
  const calls = { upserts: [] as unknown[][], updates: [] as Record<string, unknown>[] };
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
          // Recovery select (idempotency-key conflict path).
          single: async () => ({ data: opts.existingRow ?? null, error: opts.selectError ?? null }),
          // Env-flip classification select (active row for the order).
          not: () => ({
            maybeSingle: async () => ({ data: opts.activeRow ?? null, error: null }),
          }),
        }),
      }),
      update: (p: Record<string, unknown>) => {
        calls.updates.push(p);
        return {
          eq: () => ({
            eq: () => ({
              select: async () => ({ data: opts.parkedRows ?? [{ id: 'job-old' }], error: null }),
            }),
          }),
        };
      },
    };
  });
  return calls;
}

const ORDER_UNIQUE_ERROR = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "fulfilment_jobs_order_unique"',
};

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
      prodigi_env: 'sandbox', // L-19: env persisted for future flip classification
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

  // ── L-19: env-flip conflict classification ────────────────────────────────

  it('sandbox-era job + live re-enqueue: parked as failed_action_required (env_flip_conflict), no throw, no message', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = setup({
      upsertRow: null,
      upsertError: ORDER_UNIQUE_ERROR,
      activeRow: {
        id: 'job-old',
        status: 'queued',
        prodigi_env: 'sandbox',
        idempotency_key: 'prodigi:sandbox:order:ord-1:v1',
      },
    });
    const { env, send } = makeEnv(vi.fn(async () => {}), 'live');

    await expect(enqueueProdigi('ord-1', env, {} as ExecutionContext)).resolves.toBeUndefined();

    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({ status: 'failed_action_required' });
    expect(String(calls.updates[0].last_error)).toContain('env_flip_conflict');
    expect(send).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('legacy row without prodigi_env: classified via the strict idempotency-key parser', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = setup({
      upsertRow: null,
      upsertError: ORDER_UNIQUE_ERROR,
      activeRow: {
        id: 'job-old',
        status: 'queued',
        prodigi_env: null,
        idempotency_key: 'prodigi:sandbox:order:ord-1:v1',
      },
    });
    const { env } = makeEnv(vi.fn(async () => {}), 'live');

    await expect(enqueueProdigi('ord-1', env, {} as ExecutionContext)).resolves.toBeUndefined();
    expect(calls.updates[0]).toMatchObject({ status: 'failed_action_required' });
    consoleErrorSpy.mockRestore();
  });

  it('malformed legacy key + no column: NOT classified — the original error propagates', async () => {
    const calls = setup({
      upsertRow: null,
      upsertError: ORDER_UNIQUE_ERROR,
      activeRow: {
        id: 'job-old',
        status: 'queued',
        prodigi_env: null,
        idempotency_key: 'prodigi:sandbox:order:ord-1:v1:extra-suffix',
      },
    });
    const { env } = makeEnv(vi.fn(async () => {}), 'live');

    await expect(enqueueProdigi('ord-1', env, {} as ExecutionContext)).rejects.toThrow(/job upsert failed/);
    expect(calls.updates).toHaveLength(0);
  });

  it('same-env active row on the order-unique violation: propagates, never classified as env flip', async () => {
    const calls = setup({
      upsertRow: null,
      upsertError: ORDER_UNIQUE_ERROR,
      activeRow: {
        id: 'job-old',
        status: 'queued',
        prodigi_env: 'live',
        idempotency_key: 'prodigi:live:order:ord-1:v2', // hypothetical future key version
      },
    });
    const { env } = makeEnv(vi.fn(async () => {}), 'live');

    await expect(enqueueProdigi('ord-1', env, {} as ExecutionContext)).rejects.toThrow(/job upsert failed/);
    expect(calls.updates).toHaveLength(0);
  });

  it('a unique violation on a DIFFERENT constraint propagates as an error', async () => {
    const calls = setup({
      upsertRow: null,
      upsertError: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "some_other_unique"',
      },
      activeRow: {
        id: 'job-old', status: 'queued', prodigi_env: 'sandbox', idempotency_key: 'prodigi:sandbox:order:ord-1:v1',
      },
    });
    const { env } = makeEnv(vi.fn(async () => {}), 'live');

    await expect(enqueueProdigi('ord-1', env, {} as ExecutionContext)).rejects.toThrow(/job upsert failed/);
    expect(calls.updates).toHaveLength(0);
  });

  it('parseEnvFromIdempotencyKey: full-format match only', () => {
    expect(parseEnvFromIdempotencyKey('prodigi:sandbox:order:ord-1:v1')).toBe('sandbox');
    expect(parseEnvFromIdempotencyKey('prodigi:live:order:ord-1:v1')).toBe('live');
    expect(parseEnvFromIdempotencyKey('prodigi:live:order:ord-1:v1:tail')).toBeNull();
    expect(parseEnvFromIdempotencyKey('prodigi:staging:order:ord-1:v1')).toBeNull();
    expect(parseEnvFromIdempotencyKey('prodigi:live:order:v1')).toBeNull();
    expect(parseEnvFromIdempotencyKey(null)).toBeNull();
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
