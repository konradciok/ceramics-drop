import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockCaptureAlert, mockStudioEmail } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCaptureAlert: vi.fn(async (...args: unknown[]) => { void args; }),
  mockStudioEmail: vi.fn(async (...args: unknown[]) => { void args; }),
}));

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: () => ({ from: mockFrom }) }));
vi.mock('@/lib/worker-sentry', () => ({ captureWorkerAlert: mockCaptureAlert }));
vi.mock('@/lib/studio-alert-email', () => ({ sendStudioAlertEmail: mockStudioEmail }));

import {
  buildStrandedAssetJobAlert,
  STRANDED_ASSET_JOB_AFTER_MS,
  STRANDED_ASSET_JOB_BATCH_LIMIT,
  STRANDED_ASSET_JOB_STATUSES,
  sweepStrandedAssetJobs,
  type StrandedAssetJobInput,
} from './stranded-job-alert';

const ENV = {} as CloudflareEnv;

function job(overrides: Partial<StrandedAssetJobInput> = {}): StrandedAssetJobInput {
  return {
    id: 'job-1',
    uploadId: 'up-1',
    status: 'queued',
    attempts: 0,
    lastError: null,
    createdAt: '2026-09-17T08:00:00.000Z',
    ...overrides,
  };
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'job-1',
    upload_id: 'up-1',
    status: 'queued',
    attempts: 0,
    last_error: null,
    created_at: '2026-09-17T08:00:00.000Z',
    ...overrides,
  };
}

interface SweepCalls {
  filters: Array<[string, ...unknown[]]>;
  limits: number[];
  updates: Array<{ payload: Record<string, unknown>; ids: unknown; guard: unknown[] }>;
  tables: string[];
}

function setup(
  rows: unknown[],
  opts: { selectError?: { message: string } | null; markError?: { message: string } | null } = {},
): SweepCalls {
  const calls: SweepCalls = { filters: [], limits: [], updates: [], tables: [] };

  mockFrom.mockImplementation((table: string) => {
    calls.tables.push(table);
    if (table !== 'print_asset_jobs') throw new Error(`unexpected table: ${table}`);

    // Read chain: select().in().lt().is().limit() — thenable at the end.
    const readChain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: opts.selectError ?? null }).then(res),
    };
    readChain.select = vi.fn().mockReturnValue(readChain);
    for (const m of ['in', 'lt', 'is']) {
      readChain[m] = vi.fn((...args: unknown[]) => {
        calls.filters.push([m, ...args]);
        return readChain;
      });
    }
    readChain.limit = vi.fn((n: number) => {
      calls.limits.push(n);
      return readChain;
    });

    readChain.update = vi.fn((payload: Record<string, unknown>) => {
      const entry = { payload, ids: undefined as unknown, guard: [] as unknown[] };
      calls.updates.push(entry);
      const writeChain: Record<string, unknown> = {
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ error: opts.markError ?? null }).then(res),
      };
      writeChain.in = vi.fn((_col: string, ids: unknown) => {
        entry.ids = ids;
        return writeChain;
      });
      writeChain.is = vi.fn((...args: unknown[]) => {
        entry.guard = args;
        return writeChain;
      });
      return writeChain;
    });

    return readChain;
  });

  return calls;
}

describe('buildStrandedAssetJobAlert', () => {
  it('covers exactly the undispatched statuses — never processing/terminal ones', () => {
    expect([...STRANDED_ASSET_JOB_STATUSES]).toEqual(['queued', 'failed_retryable']);
    // `processing` is Task G's lease/fencing concern, not a never-dispatched job.
    expect(STRANDED_ASSET_JOB_STATUSES).not.toContain('processing');
    expect(STRANDED_ASSET_JOB_STATUSES).not.toContain('completed');
    // failed_action_required already alerts synchronously in process-job.ts.
    expect(STRANDED_ASSET_JOB_STATUSES).not.toContain('failed_action_required');
  });

  it('builds a warning-level Sentry payload + log with per-job status/attempts/createdAt', () => {
    const alert = buildStrandedAssetJobAlert([
      job({ id: 'j1', status: 'failed_retryable', attempts: 3, lastError: 'container RPC failed' }),
      job({ id: 'j2', status: 'queued' }),
    ]);
    expect(alert.sentry.level).toBe('warning');
    expect(alert.sentry.message).toBe('print_asset_job_stranded');
    expect(alert.log.event).toBe('print_asset_job_stranded');
    expect(alert.log.count).toBe(2);
    expect(alert.log.jobs[0]).toMatchObject({
      id: 'j1',
      status: 'failed_retryable',
      attempts: 3,
      lastErrorSnippet: 'container RPC failed',
      createdAt: '2026-09-17T08:00:00.000Z',
    });
    expect(alert.log.jobs[1].lastErrorSnippet).toBe('—');
    expect(alert.email.subject).toContain('2');
  });

  it('names both recovery levers so the alert is actionable', () => {
    const alert = buildStrandedAssetJobAlert([job()]);
    expect(alert.email.html).toContain('POST /v1/jobs');
    expect(alert.email.html).toContain('/retry');
    expect(alert.email.html).toContain('up-1'); // uploadId — needed to re-POST /v1/jobs
  });

  it('truncates a long last_error so the event/email stay small', () => {
    const alert = buildStrandedAssetJobAlert([job({ lastError: 'x'.repeat(500) })]);
    expect(alert.log.jobs[0].lastErrorSnippet).toHaveLength(301); // 300 + ellipsis
    expect(alert.log.jobs[0].lastErrorSnippet.endsWith('…')).toBe(true);
  });

  it('escapes HTML in job fields (no injection into the studio email)', () => {
    const alert = buildStrandedAssetJobAlert([job({ lastError: '<img src=x onerror=alert(1)>' })]);
    expect(alert.email.html).not.toContain('<img src=x');
    expect(alert.email.html).toContain('&lt;img src=x');
  });

  it('caps rendered sections at 10 and summarises the remainder', () => {
    const jobs = Array.from({ length: 13 }, (_, i) => job({ id: `j${i}`, uploadId: `u${i}` }));
    const alert = buildStrandedAssetJobAlert(jobs);
    expect(alert.log.count).toBe(13);
    expect(alert.email.html).toContain('i 3 kolejnych'); // 13 - 10 shown
  });
});

describe('sweepStrandedAssetJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('selects only undispatched statuses older than the cutoff, and only unalerted rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
    try {
      const calls = setup([]);
      await sweepStrandedAssetJobs(ENV);

      const statusFilter = calls.filters.find(([m, col]) => m === 'in' && col === 'status');
      expect(statusFilter?.[2]).toEqual(['queued', 'failed_retryable']);

      const cutoffFilter = calls.filters.find(([m, col]) => m === 'lt' && col === 'created_at');
      // created_at (not updated_at): a failed_retryable job's updated_at is
      // bumped on every retry, which would hide a job failing for hours.
      expect(cutoffFilter?.[2]).toBe(
        new Date(Date.parse('2026-09-17T12:00:00.000Z') - STRANDED_ASSET_JOB_AFTER_MS).toISOString(),
      );

      const guard = calls.filters.find(([m, col]) => m === 'is' && col === 'stranded_alerted_at');
      expect(guard?.[2]).toBeNull();

      expect(calls.limits).toEqual([STRANDED_ASSET_JOB_BATCH_LIMIT]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing and marks nothing when no row is stranded', async () => {
    const calls = setup([]);
    const result = await sweepStrandedAssetJobs(ENV);

    expect(result).toEqual({ scanned: 0, alerted: 0 });
    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(mockStudioEmail).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(0);
  });

  it('alerts once and marks stranded_alerted_at only for the rows it alerted', async () => {
    const calls = setup([
      row({ id: 'j1' }),
      row({ id: 'j2', status: 'failed_retryable', attempts: 4, last_error: 'boom' }),
    ]);

    const result = await sweepStrandedAssetJobs(ENV);

    expect(mockCaptureAlert).toHaveBeenCalledExactlyOnceWith(ENV, expect.objectContaining({
      message: 'print_asset_job_stranded',
      level: 'warning',
    }));
    expect(mockStudioEmail).toHaveBeenCalledExactlyOnceWith(
      ENV,
      expect.objectContaining({ subject: expect.stringContaining('2') }),
      'stranded print asset jobs',
    );
    expect(calls.updates).toHaveLength(1);
    expect(Object.keys(calls.updates[0].payload)).toEqual(['stranded_alerted_at']);
    expect(typeof calls.updates[0].payload.stranded_alerted_at).toBe('string');
    // `updated_at` is the job's own progress clock — an alert is not progress.
    expect(calls.updates[0].payload).not.toHaveProperty('updated_at');
    expect(calls.updates[0].ids).toEqual(['j1', 'j2']);
    // Once-only guard: the mark itself re-asserts stranded_alerted_at IS NULL,
    // so a concurrent sweep cannot double-mark.
    expect(calls.updates[0].guard).toEqual(['stranded_alerted_at', null]);
    expect(result).toEqual({ scanned: 2, alerted: 2 });
  });

  it('does NOT mark when the studio email fails — the row is re-alerted next tick', async () => {
    const calls = setup([row()]);
    mockStudioEmail.mockRejectedValueOnce(new Error('Resend 500'));

    await expect(sweepStrandedAssetJobs(ENV)).rejects.toThrow('Resend 500');
    expect(calls.updates).toHaveLength(0);
  });

  it('throws a labelled error when the selection query fails', async () => {
    setup([], { selectError: { message: 'connection reset' } });
    await expect(sweepStrandedAssetJobs(ENV)).rejects.toThrow(
      /sweepStrandedAssetJobs query failed: connection reset/,
    );
    expect(mockStudioEmail).not.toHaveBeenCalled();
  });

  it('throws a labelled error when the mark fails (caller alerts a dead sweep)', async () => {
    setup([row()], { markError: { message: 'deadlock' } });
    await expect(sweepStrandedAssetJobs(ENV)).rejects.toThrow(
      /sweepStrandedAssetJobs mark failed: deadlock/,
    );
    expect(mockStudioEmail).toHaveBeenCalledOnce();
  });
});
