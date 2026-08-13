import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { mockGetOrder, mockShipEmail, mockCaptureMessage } = vi.hoisted(() => ({
  mockGetOrder: vi.fn(),
  mockShipEmail: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('./client', async (importOriginal) => {
  // Spread the real module so ProdigiError stays the real class (merge.ts
  // instanceof-checks it when classifying re-fetch failures).
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, prodigiClient: vi.fn(() => ({ getOrder: mockGetOrder })) };
});
vi.mock('@/lib/email', () => ({ emailPrintShippingConfirmationToCustomer: mockShipEmail }));
vi.mock('@sentry/nextjs', () => ({
  captureMessage: mockCaptureMessage,
  captureException: vi.fn(),
}));

import { fetchAndMergeProdigiOrder } from './merge';

const ENV = {} as CloudflareEnv;

function prodigiOrder(stage: string | undefined) {
  return {
    order: {
      id: 'pr_1',
      merchantReference: 'o1',
      status: stage === undefined ? undefined : { stage },
      items: [],
      shipments: [],
    },
  };
}

/** Thenable chain: builder methods return the chain; awaiting resolves `result`. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  for (const m of ['select', 'eq', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.single = vi.fn().mockResolvedValue(result);
  return chain;
}

/** Minimal Supabase double covering the tables fetchAndMergeProdigiOrder touches:
 *  no existing prodigi_orders row (forces the merchantReference → orders lookup),
 *  no active fulfilment job (that branch is exercised elsewhere, e.g. callbacks.test.ts). */
function setupSupabase() {
  const calls = { poUpserts: [] as Record<string, unknown>[] };
  const from = vi.fn((table: string) => {
    if (table === 'prodigi_orders') {
      return {
        select: () => makeChain({ data: null, error: null }),
        upsert: (p: Record<string, unknown>) => {
          calls.poUpserts.push(p);
          return makeChain({ error: null });
        },
      };
    }
    if (table === 'orders') {
      return { select: () => makeChain({ data: { id: 'o1' }, error: null }) };
    }
    if (table === 'fulfilment_jobs') {
      return { select: () => makeChain({ data: null, error: null }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { supabase: { from } as unknown as SupabaseClient, calls };
}

describe('fetchAndMergeProdigiOrder — unrecognised status.stage clamp (I-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShipEmail.mockResolvedValue(undefined);
  });

  it('clamps an unrecognised stage to Unknown before persisting, and alerts Sentry', async () => {
    mockGetOrder.mockResolvedValue(prodigiOrder('SomeNewStage'));
    const { supabase, calls } = setupSupabase();

    const result = await fetchAndMergeProdigiOrder(supabase, ENV, 'pr_1');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newStage).toBe('Unknown');
    expect(calls.poUpserts).toHaveLength(1);
    // The whole point of the fix: the CHECK-constrained column must never see
    // the raw, unrecognised value — only the clamped 'Unknown'.
    expect(calls.poUpserts[0]).toMatchObject({ prodigi_status_stage: 'Unknown' });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'prodigi order returned an unrecognised status stage',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ prodigiOrderId: 'pr_1', rawStage: 'SomeNewStage' }),
      }),
    );
  });

  it('a recognised stage is persisted verbatim with no Sentry alert', async () => {
    mockGetOrder.mockResolvedValue(prodigiOrder('InProgress'));
    const { supabase, calls } = setupSupabase();

    const result = await fetchAndMergeProdigiOrder(supabase, ENV, 'pr_1');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newStage).toBe('InProgress');
    expect(calls.poUpserts[0]).toMatchObject({ prodigi_status_stage: 'InProgress' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('an absent stage still falls back to Unknown with no Sentry alert (pre-existing behaviour preserved)', async () => {
    mockGetOrder.mockResolvedValue(prodigiOrder(undefined));
    const { supabase, calls } = setupSupabase();

    const result = await fetchAndMergeProdigiOrder(supabase, ENV, 'pr_1');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newStage).toBe('Unknown');
    expect(calls.poUpserts[0]).toMatchObject({ prodigi_status_stage: 'Unknown' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
