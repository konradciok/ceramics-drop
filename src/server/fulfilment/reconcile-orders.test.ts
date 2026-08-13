import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockMerge, mockCaptureAlert, mockStudioEmail } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockMerge: vi.fn(),
  mockCaptureAlert: vi.fn(async () => {}),
  mockStudioEmail: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: () => ({ from: mockFrom }) }));
vi.mock('../prodigi/merge', () => ({ fetchAndMergeProdigiOrder: mockMerge }));
vi.mock('@/lib/worker-sentry', () => ({ captureWorkerAlert: mockCaptureAlert }));
vi.mock('@/lib/studio-alert-email', () => ({ sendStudioAlertEmail: mockStudioEmail }));

import {
  buildStalledOrderAlertEmail,
  PRODIGI_TERMINAL_STAGES,
  STALLED_POLL_ALERT_THRESHOLD,
  sweepStaleProdigiOrders,
} from './reconcile-orders';

const ENV = {} as CloudflareEnv;

function staleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'po-1',
    order_id: 'o1',
    prodigi_order_id: 'pr_1',
    prodigi_status_stage: 'InProgress',
    stalled_poll_count: 0,
    ...overrides,
  };
}

function setup(rows: unknown[], opts: { selectError?: { message: string } | null } = {}) {
  const calls = {
    filters: [] as Array<[string, ...unknown[]]>,
    updates: [] as Array<Record<string, unknown>>,
  };
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'prodigi_orders') throw new Error(`unexpected table: ${table}`);
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: opts.selectError ?? null }).then(res),
    };
    for (const m of ['select', 'or', 'limit']) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.not = vi.fn((...args: unknown[]) => {
      calls.filters.push(['not', ...args]);
      return chain;
    });
    chain.update = vi.fn((p: Record<string, unknown>) => {
      calls.updates.push(p);
      return { eq: vi.fn().mockResolvedValue({ error: null }) };
    });
    return chain;
  });
  return calls;
}

describe('sweepStaleProdigiOrders (M-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('excludes terminal Prodigi stages from the selection', async () => {
    const calls = setup([]);
    await sweepStaleProdigiOrders(ENV);

    const stageFilter = calls.filters.find(
      ([, col]) => col === 'prodigi_status_stage',
    );
    expect(stageFilter).toBeDefined();
    for (const stage of PRODIGI_TERMINAL_STAGES) {
      expect(String(stageFilter![3])).toContain(stage);
    }
    expect(mockMerge).not.toHaveBeenCalled();
  });

  it('a stale row that advances on poll: merge ran, stalled_poll_count resets, no alert', async () => {
    const calls = setup([staleRow({ stalled_poll_count: 1 })]);
    mockMerge.mockResolvedValueOnce({
      ok: true, orderId: 'o1', newStage: 'Complete', localStatus: 'shipped', progressed: true,
    });

    const result = await sweepStaleProdigiOrders(ENV);

    expect(mockMerge).toHaveBeenCalledExactlyOnceWith(expect.anything(), ENV, 'pr_1');
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({ stalled_poll_count: 0 });
    expect(typeof calls.updates[0].last_reconciled_at).toBe('string');
    expect(calls.updates[0]).not.toHaveProperty('updated_at'); // reconciliation clock only
    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, progressed: 1, stalledAlerts: 0 });
  });

  it('first no-progress poll: count increments, still no alert', async () => {
    const calls = setup([staleRow({ stalled_poll_count: 0 })]);
    mockMerge.mockResolvedValueOnce({
      ok: true, orderId: 'o1', newStage: 'InProgress', localStatus: 'fulfilment_submitted', progressed: false,
    });

    await sweepStaleProdigiOrders(ENV);

    expect(calls.updates[0]).toMatchObject({ stalled_poll_count: 1 });
    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(mockStudioEmail).not.toHaveBeenCalled();
  });

  it(`no-progress poll #${STALLED_POLL_ALERT_THRESHOLD}: fires prodigi_order_stalled once (Sentry + studio email)`, async () => {
    const calls = setup([staleRow({ stalled_poll_count: STALLED_POLL_ALERT_THRESHOLD - 1 })]);
    mockMerge.mockResolvedValueOnce({
      ok: true, orderId: 'o1', newStage: 'InProgress', localStatus: 'fulfilment_submitted', progressed: false,
    });

    const result = await sweepStaleProdigiOrders(ENV);

    expect(calls.updates[0]).toMatchObject({ stalled_poll_count: STALLED_POLL_ALERT_THRESHOLD });
    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    expect(mockCaptureAlert.mock.calls[0][1]).toMatchObject({ message: 'prodigi_order_stalled', level: 'warning' });
    expect(mockStudioEmail).toHaveBeenCalledTimes(1);
    expect(result.stalledAlerts).toBe(1);
  });

  it('a poll past the threshold stays quiet (alert fired only on the transition)', async () => {
    setup([staleRow({ stalled_poll_count: STALLED_POLL_ALERT_THRESHOLD })]);
    mockMerge.mockResolvedValueOnce({
      ok: true, orderId: 'o1', newStage: 'InProgress', localStatus: 'fulfilment_submitted', progressed: false,
    });

    await sweepStaleProdigiOrders(ENV);

    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(mockStudioEmail).not.toHaveBeenCalled();
  });

  it('a Prodigi 404 alerts loudly (order vanished) and still advances the poll clock', async () => {
    const calls = setup([staleRow()]);
    mockMerge.mockResolvedValueOnce({
      ok: false, reason: 'refetch_failed', message: 'Failed to re-fetch Prodigi order', status: 404,
    });

    const result = await sweepStaleProdigiOrders(ENV);

    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    expect(mockCaptureAlert.mock.calls[0][1]).toMatchObject({ message: 'prodigi_reconcile_order_missing', level: 'error' });
    expect(mockStudioEmail).toHaveBeenCalledTimes(1);
    expect(calls.updates).toHaveLength(1); // last_reconciled_at bumped → bounded re-alerts
    expect(result.errors).toBe(1);
  });

  it('a transient re-fetch failure only logs — no clock bump, next tick retries', async () => {
    const calls = setup([staleRow()]);
    mockMerge.mockResolvedValueOnce({
      ok: false, reason: 'refetch_failed', message: 'Prodigi 503', status: 503,
    });

    const result = await sweepStaleProdigiOrders(ENV);

    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(0);
    expect(result.errors).toBe(1);
  });

  it('a per-row email failure never aborts the sweep', async () => {
    setup([
      staleRow({ id: 'po-1', prodigi_order_id: 'pr_1', stalled_poll_count: 1 }),
      staleRow({ id: 'po-2', prodigi_order_id: 'pr_2', stalled_poll_count: 0 }),
    ]);
    mockStudioEmail.mockRejectedValueOnce(new Error('resend down'));
    mockMerge
      .mockResolvedValueOnce({ ok: true, orderId: 'o1', newStage: 'InProgress', localStatus: null, progressed: false })
      .mockResolvedValueOnce({ ok: true, orderId: 'o2', newStage: 'Complete', localStatus: 'shipped', progressed: true });

    const result = await sweepStaleProdigiOrders(ENV);

    expect(mockMerge).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scanned: 2, progressed: 1 });
  });

  it('throws when the selection query fails (caller alerts the dead sweep)', async () => {
    setup([], { selectError: { message: 'db down' } });
    await expect(sweepStaleProdigiOrders(ENV)).rejects.toThrow(/query failed/);
  });
});

describe('buildStalledOrderAlertEmail', () => {
  it('renders the stalled variant with ids and escaped values', () => {
    const email = buildStalledOrderAlertEmail({
      orderId: 'o<1>', prodigiOrderId: 'pr_1', stage: 'InProgress', polls: 2, missing: false,
    });
    expect(email.subject).toContain('pr_1');
    expect(email.html).toContain('o&lt;1&gt;');
    expect(email.html).toContain('InProgress');
  });

  it('renders the 404 variant', () => {
    const email = buildStalledOrderAlertEmail({
      orderId: 'o1', prodigiOrderId: 'pr_1', stage: null, polls: 0, missing: true,
    });
    expect(email.subject).toContain('404');
  });
});
