import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

const { mockFrom, mockGetOrderActions, mockCancelOrder, mockAlertEmail } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockGetOrderActions: vi.fn(),
  mockCancelOrder: vi.fn(),
  mockAlertEmail: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('../prodigi/client', () => ({
  prodigiClient: vi.fn(() => ({ getOrderActions: mockGetOrderActions, cancelOrder: mockCancelOrder })),
}));
vi.mock('@/lib/email', () => ({ emailPrintRefundAlertToStudio: mockAlertEmail }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { cancelPrintFulfilment } from './cancel-print';

const ENV = {} as CloudflareEnv;

/** Thenable chain: every builder method returns the chain; awaiting resolves `result`. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  for (const m of ['select', 'eq', 'not', 'is', 'in', 'update']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

type PoRow = { prodigi_order_id: string; prodigi_status_stage: string; cancel_alerted_at: string | null };

function setup(opts: {
  printCount?: number;
  po?: PoRow | null;
  /** Rows returned by the cancel_alerted_at claim UPDATE (empty = claim lost). */
  claimRows?: unknown[];
  /** Rows returned by the in-flight job cancel UPDATE (non-empty = job was submitting/submitted). */
  inflightRows?: unknown[];
  /** Override the order_items count query result (e.g. a DB error). */
  itemsResult?: unknown;
}) {
  const calls = {
    tables: [] as string[],
    jobUpdates: [] as Record<string, unknown>[],
    stageUpdates: [] as Record<string, unknown>[],
    claimUpdates: [] as Record<string, unknown>[],
  };
  mockFrom.mockImplementation((table: string) => {
    calls.tables.push(table);
    if (table === 'order_items') return makeChain(opts.itemsResult ?? { count: opts.printCount ?? 0, error: null });
    if (table === 'fulfilment_jobs') {
      const chain = makeChain({ error: null });
      chain.update = vi.fn((p: Record<string, unknown>) => {
        calls.jobUpdates.push(p);
        // The in-flight cancel is the one that `.select()`s its rows back.
        if (String(p.last_error).includes('mid-submission')) {
          return makeChain({ data: opts.inflightRows ?? [], error: null });
        }
        return chain;
      });
      return chain;
    }
    if (table === 'prodigi_orders') {
      const chain = makeChain({ data: opts.po ?? null, error: null });
      chain.update = vi.fn((p: Record<string, unknown>) => {
        if ('cancel_alerted_at' in p) {
          calls.claimUpdates.push(p);
          return makeChain({ data: opts.claimRows ?? [{ order_id: 'o1' }], error: null });
        }
        calls.stageUpdates.push(p);
        return makeChain({ error: null });
      });
      return chain;
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return calls;
}

const CANCELLABLE_PO: PoRow = { prodigi_order_id: 'pr_1', prodigi_status_stage: 'InProgress', cancel_alerted_at: null };
const SHIPPED_PO: PoRow = { prodigi_order_id: 'pr_1', prodigi_status_stage: 'Complete', cancel_alerted_at: null };

describe('cancelPrintFulfilment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrderActions.mockResolvedValue({ outcome: 'Ok', cancel: { isAvailable: 'Yes' } });
    mockCancelOrder.mockResolvedValue({ outcome: 'Cancelled' });
    mockAlertEmail.mockResolvedValue(undefined);
  });

  it('ceramic order (no print items): touches nothing beyond the item count', async () => {
    const calls = setup({ printCount: 0 });
    await cancelPrintFulfilment('o1', ENV);
    expect(calls.tables).toEqual(['order_items']);
    expect(mockGetOrderActions).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockAlertEmail).not.toHaveBeenCalled();
  });

  it('cancellable print order: cancels once, records stage Cancelled, no alert', async () => {
    const calls = setup({ printCount: 1, po: CANCELLABLE_PO });
    await cancelPrintFulfilment('o1', ENV);
    expect(mockCancelOrder).toHaveBeenCalledTimes(1);
    expect(mockCancelOrder).toHaveBeenCalledWith('pr_1');
    expect(calls.stageUpdates).toHaveLength(1);
    expect(calls.stageUpdates[0]).toMatchObject({ prodigi_status_stage: 'Cancelled' });
    expect(mockAlertEmail).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('shipped print order (cancel unavailable): no cancel call, Sentry + studio email fired once', async () => {
    mockGetOrderActions.mockResolvedValue({ outcome: 'Ok', cancel: { isAvailable: 'No' } });
    const calls = setup({ printCount: 1, po: SHIPPED_PO });
    await cancelPrintFulfilment('o1', ENV);
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(calls.claimUpdates).toHaveLength(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'print_refund_manual_cancel_required',
      expect.objectContaining({ extra: expect.objectContaining({ orderId: 'o1', prodigiOrderId: 'pr_1' }) }),
    );
    expect(mockAlertEmail).toHaveBeenCalledTimes(1);
    expect(mockAlertEmail).toHaveBeenCalledWith({ orderId: 'o1', prodigiOrderId: 'pr_1', stage: 'Complete' });
  });

  it('cancel attempt refused by Prodigi (FailedToCancel): falls through to the alert', async () => {
    const calls = setup({ printCount: 1, po: CANCELLABLE_PO });
    mockCancelOrder.mockResolvedValue({ outcome: 'FailedToCancel' });
    await cancelPrintFulfilment('o1', ENV);
    expect(calls.stageUpdates).toHaveLength(0);
    expect(mockAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('refund before submission (no prodigi_orders row): kills the queued job, never calls Prodigi', async () => {
    const calls = setup({ printCount: 1, po: null });
    await cancelPrintFulfilment('o1', ENV);
    // Two CAS updates: queued (silent) + post-POST states (alerting).
    expect(calls.jobUpdates).toHaveLength(2);
    expect(calls.jobUpdates[0]).toMatchObject({ status: 'cancelled' });
    expect(calls.jobUpdates[1]).toMatchObject({ status: 'cancelled' });
    expect(mockGetOrderActions).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockAlertEmail).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('refund after retryable POST failure (failed_retryable, no prodigi_orders row): kills the job AND alerts', async () => {
    const calls = setup({ printCount: 1, po: null, inflightRows: [{ id: 'j1' }] });
    await cancelPrintFulfilment('o1', ENV);
    expect(calls.jobUpdates).toHaveLength(2);
    expect(mockGetOrderActions).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'print_refund_manual_cancel_required',
      expect.objectContaining({ extra: expect.objectContaining({ orderId: 'o1', prodigiOrderId: 'unknown' }) }),
    );
    expect(mockAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('refund mid-submission (job claimed, no prodigi_orders row): kills the job AND alerts', async () => {
    const calls = setup({ printCount: 1, po: null, inflightRows: [{ id: 'j1' }] });
    await cancelPrintFulfilment('o1', ENV);
    expect(calls.jobUpdates).toHaveLength(2);
    expect(mockGetOrderActions).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'print_refund_manual_cancel_required',
      expect.objectContaining({ extra: expect.objectContaining({ orderId: 'o1', prodigiOrderId: 'unknown' }) }),
    );
    expect(mockAlertEmail).toHaveBeenCalledTimes(1);
    expect(mockAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1', prodigiOrderId: expect.stringContaining('o1') }),
    );
  });

  it('already cancelled: no Prodigi calls, no alert (idempotent)', async () => {
    const calls = setup({
      printCount: 1,
      po: { prodigi_order_id: 'pr_1', prodigi_status_stage: 'Cancelled', cancel_alerted_at: null },
    });
    await cancelPrintFulfilment('o1', ENV);
    expect(mockGetOrderActions).not.toHaveBeenCalled();
    expect(mockAlertEmail).not.toHaveBeenCalled();
    expect(calls.stageUpdates).toHaveLength(0);
  });

  it('already alerted (cancel_alerted_at set): no second alert (idempotent)', async () => {
    setup({
      printCount: 1,
      po: { prodigi_order_id: 'pr_1', prodigi_status_stage: 'Complete', cancel_alerted_at: '2026-07-01T00:00:00Z' },
    });
    await cancelPrintFulfilment('o1', ENV);
    expect(mockGetOrderActions).not.toHaveBeenCalled();
    expect(mockAlertEmail).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('claim CAS lost to a concurrent caller: no duplicate email', async () => {
    mockGetOrderActions.mockResolvedValue({ outcome: 'Ok', cancel: { isAvailable: 'No' } });
    setup({ printCount: 1, po: SHIPPED_PO, claimRows: [] });
    await cancelPrintFulfilment('o1', ENV);
    expect(mockAlertEmail).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('accepts a lowercase cancel outcome (Prodigi docs mix casings)', async () => {
    const calls = setup({ printCount: 1, po: CANCELLABLE_PO });
    mockCancelOrder.mockResolvedValue({ outcome: 'cancelled' });
    await cancelPrintFulfilment('o1', ENV);
    expect(calls.stageUpdates).toHaveLength(1);
    expect(calls.stageUpdates[0]).toMatchObject({ prodigi_status_stage: 'Cancelled' });
    expect(mockAlertEmail).not.toHaveBeenCalled();
  });

  it('accepts a lowercase isAvailable and still cancels', async () => {
    mockGetOrderActions.mockResolvedValue({ outcome: 'Ok', cancel: { isAvailable: 'yes' } });
    setup({ printCount: 1, po: CANCELLABLE_PO });
    await cancelPrintFulfilment('o1', ENV);
    expect(mockCancelOrder).toHaveBeenCalledTimes(1);
  });

  it('non-Ok getOrderActions outcome: no cancel attempt, no false alert, Sentry exception', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetOrderActions.mockResolvedValue({ outcome: 'Error', cancel: { isAvailable: 'Yes' } });
    setup({ printCount: 1, po: CANCELLABLE_PO });
    await expect(cancelPrintFulfilment('o1', ENV)).resolves.toBeUndefined();
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockAlertEmail).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('never throws: a DB error on the order_items count is swallowed and captured in Sentry', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setup({ itemsResult: { count: null, error: { message: 'db down' } } });
    await expect(cancelPrintFulfilment('o1', ENV)).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockGetOrderActions).not.toHaveBeenCalled();
    expect(mockAlertEmail).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('Prodigi network failure on a known order: alerts studio instead of Sentry-only', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetOrderActions.mockRejectedValue(new Error('prodigi down'));
    setup({ printCount: 1, po: CANCELLABLE_PO });
    await expect(cancelPrintFulfilment('o1', ENV)).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'print_refund_manual_cancel_required',
      expect.objectContaining({ extra: expect.objectContaining({ orderId: 'o1', prodigiOrderId: 'pr_1' }) }),
    );
    expect(mockAlertEmail).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('never throws: an alert email failure is swallowed and captured in Sentry', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetOrderActions.mockResolvedValue({ outcome: 'Ok', cancel: { isAvailable: 'No' } });
    mockAlertEmail.mockRejectedValue(new Error('resend down'));
    setup({ printCount: 1, po: SHIPPED_PO });
    await expect(cancelPrintFulfilment('o1', ENV)).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
