import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockGetOrder, mockShipEmail } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockGetOrder: vi.fn(),
  mockShipEmail: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('./client', async (importOriginal) => {
  // Spread the real module so ProdigiError stays the real class (merge.ts
  // instanceof-checks it when classifying re-fetch failures).
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, prodigiClient: vi.fn(() => ({ getOrder: mockGetOrder })) };
});
vi.mock('@/lib/email', () => ({ emailPrintShippingConfirmationToCustomer: mockShipEmail }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { handleProdigiCallback, LEASE_MINUTES } from './callbacks';
import * as Sentry from '@sentry/nextjs';

const ENV = {} as CloudflareEnv;

function callbackBody(stage = 'Complete') {
  return {
    id: 'evt-1',
    type: 'com.prodigi.order.status.stage#changed',
    data: { prodigiOrderId: 'pr_1', stage },
  };
}

function prodigiOrder(stage = 'Complete') {
  return {
    order: {
      id: 'pr_1',
      merchantReference: 'o1',
      status: { stage },
      items: [],
      shipments: [
        {
          id: 'shp_1',
          status: 'Shipped',
          carrier: { name: 'dpd', service: 'Standard' },
          tracking: { number: 'TRK123', url: 'https://track.example.com/TRK123' },
        },
      ],
    },
  };
}

/** Thenable chain: builder methods return the chain; awaiting resolves `result`. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.single = vi.fn().mockResolvedValue(result);
  return chain;
}

function setup(opts: {
  existingEvent?: { id: string; status: string; processing_started_at: string | null } | null;
  /** Rows returned by the shipping_email_sent_at claim UPDATE (empty = already claimed). */
  claimRows?: unknown[];
  orderRow?: Record<string, unknown> | null;
  /** prodigi_orders lookup row (may carry persisted tracking columns); explicit null = unknown Prodigi order. */
  poRow?: Record<string, unknown> | null;
  jobRow?: { id: string; status: string } | null;
} = {}) {
  const calls = {
    shippingClaims: [] as Record<string, unknown>[],
    jobUpdates: [] as Record<string, unknown>[],
    eventUpdates: [] as Record<string, unknown>[],
    eventInserts: [] as Record<string, unknown>[],
    poUpserts: [] as Record<string, unknown>[],
  };
  mockFrom.mockImplementation((table: string) => {
    if (table === 'webhook_events') {
      return {
        select: () => makeChain({ data: opts.existingEvent ?? null, error: null }),
        insert: (p: Record<string, unknown>) => {
          calls.eventInserts.push(p);
          return makeChain({ error: null });
        },
        update: (p: Record<string, unknown>) => {
          calls.eventUpdates.push(p);
          return makeChain({ data: [{ id: 'we-1' }], error: null });
        },
      };
    }
    if (table === 'prodigi_orders') {
      return {
        select: () =>
          makeChain({ data: opts.poRow !== undefined ? opts.poRow : { order_id: 'o1' }, error: null }),
        upsert: (p: Record<string, unknown>) => {
          calls.poUpserts.push(p);
          return makeChain({ error: null });
        },
        update: (p: Record<string, unknown>) => {
          calls.shippingClaims.push(p);
          if (p.shipping_email_sent_at === null) return makeChain({ data: [], error: null }); // claim release
          return makeChain({ data: opts.claimRows ?? [{ order_id: 'o1' }], error: null });
        },
      };
    }
    if (table === 'fulfilment_jobs') {
      return {
        select: () =>
          makeChain({
            data: opts.jobRow !== undefined ? opts.jobRow : { id: 'j1', status: 'in_production' },
            error: null,
          }),
        update: (p: Record<string, unknown>) => {
          calls.jobUpdates.push(p);
          return makeChain({ error: null });
        },
      };
    }
    if (table === 'orders') {
      return {
        select: () =>
          makeChain({
            data:
              opts.orderRow !== undefined
                ? opts.orderRow
                : { id: 'o1', email: 'buyer@example.com', receiver_first_name: 'Anna', locale: 'en' },
            error: null,
          }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return calls;
}

describe('handleProdigiCallback — print shipping email (Finding 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrder.mockResolvedValue(prodigiOrder('Complete'));
    mockShipEmail.mockResolvedValue(undefined);
  });

  it('Complete stage: sends the tracking email once with carrier tracking + locale', async () => {
    setup();

    const res = await handleProdigiCallback(callbackBody(), ENV);

    expect(res.status).toBe(200);
    expect(mockShipEmail).toHaveBeenCalledTimes(1);
    expect(mockShipEmail).toHaveBeenCalledWith({
      order: { id: 'o1', email: 'buyer@example.com', receiver_first_name: 'Anna', locale: 'en' },
      tracking: { number: 'TRK123', url: 'https://track.example.com/TRK123', carrier: 'dpd' },
      locale: 'en',
    });
  });

  it('claim already taken: a replayed Complete callback sends zero additional emails', async () => {
    setup({ claimRows: [] });

    const res = await handleProdigiCallback({ ...callbackBody(), id: 'evt-2' }, ENV);

    expect(res.status).toBe(200);
    expect(mockShipEmail).not.toHaveBeenCalled();
  });

  it('replay of an already-done event short-circuits before any Prodigi call', async () => {
    setup({ existingEvent: { id: 'we-1', status: 'done', processing_started_at: null } });

    const res = await handleProdigiCallback(callbackBody(), ENV);

    expect(res.status).toBe(200);
    expect(res.message).toBe('Already processed');
    expect(mockGetOrder).not.toHaveBeenCalled();
    expect(mockShipEmail).not.toHaveBeenCalled();
  });

  it('non-shipped stage (InProduction): no claim attempt, no email', async () => {
    mockGetOrder.mockResolvedValue(prodigiOrder('InProduction'));
    const calls = setup();

    const res = await handleProdigiCallback(callbackBody('InProduction'), ENV);

    expect(res.status).toBe(200);
    expect(calls.shippingClaims).toHaveLength(0);
    expect(mockShipEmail).not.toHaveBeenCalled();
  });

  it('send failure: retries 3×, alerts Sentry, releases OUR claim, and still completes', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockShipEmail.mockRejectedValue(new Error('resend down'));
    const calls = setup();

    const res = await handleProdigiCallback(callbackBody(), ENV);

    expect(res.status).toBe(200);
    expect(mockShipEmail).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(calls.shippingClaims).toHaveLength(2);
    expect(typeof calls.shippingClaims[0].shipping_email_sent_at).toBe('string');
    expect(calls.shippingClaims[1].shipping_email_sent_at).toBeNull();
    consoleErrorSpy.mockRestore();
  });

  it('missing customer email: no claim written, no send', async () => {
    const calls = setup({ orderRow: { id: 'o1', email: null, receiver_first_name: 'Anna', locale: 'en' } });

    const res = await handleProdigiCallback(callbackBody(), ENV);

    expect(res.status).toBe(200);
    expect(calls.shippingClaims).toHaveLength(0);
    expect(mockShipEmail).not.toHaveBeenCalled();
  });
});

describe('handleProdigiCallback — monotonic tracking persistence (PR #186 P2)', () => {
  const STORED = {
    order_id: 'o1',
    carrier: 'dpd',
    tracking_number: 'TRK123',
    tracking_url: 'https://track.example.com/TRK123',
    shipped_at: '2026-07-20T10:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockShipEmail.mockResolvedValue(undefined);
  });

  it('persists the primary shipment tracking columns on a tracked callback', async () => {
    mockGetOrder.mockResolvedValue(prodigiOrder('Complete'));
    const calls = setup();

    const res = await handleProdigiCallback(callbackBody(), ENV);

    expect(res.status).toBe(200);
    expect(calls.poUpserts).toHaveLength(1);
    expect(calls.poUpserts[0]).toMatchObject({
      carrier: 'dpd',
      tracking_number: 'TRK123',
      tracking_url: 'https://track.example.com/TRK123',
    });
  });

  it('a later sparse callback (no shipments) preserves previously persisted tracking', async () => {
    mockGetOrder.mockResolvedValue({
      order: { ...prodigiOrder('Complete').order, shipments: [] },
    });
    const calls = setup({ poRow: STORED, claimRows: [] });

    const res = await handleProdigiCallback({ ...callbackBody(), id: 'evt-sparse' }, ENV);

    expect(res.status).toBe(200);
    expect(calls.poUpserts).toHaveLength(1);
    expect(calls.poUpserts[0]).toMatchObject({
      carrier: 'dpd',
      tracking_number: 'TRK123',
      tracking_url: 'https://track.example.com/TRK123',
      shipped_at: '2026-07-20T10:00:00.000Z',
    });
  });

  it('a shipment missing individual fields keeps the stored values for those fields only', async () => {
    mockGetOrder.mockResolvedValue({
      order: {
        ...prodigiOrder('Complete').order,
        shipments: [
          { id: 'shp_2', status: 'Shipped', carrier: { name: 'dhl' }, tracking: { number: 'TRK999' } },
        ],
      },
    });
    const calls = setup({ poRow: STORED, claimRows: [] });

    await handleProdigiCallback({ ...callbackBody(), id: 'evt-partial' }, ENV);

    expect(calls.poUpserts[0]).toMatchObject({
      carrier: 'dhl', // fresh value wins…
      tracking_number: 'TRK999',
      tracking_url: 'https://track.example.com/TRK123', // …absent fields keep the stored values
      shipped_at: '2026-07-20T10:00:00.000Z',
    });
  });

  it('a no-op merge (same stage, same tracking) does NOT refresh updated_at — the M-12 clock separation', async () => {
    // Stored row already matches everything the re-fetched order carries: the
    // upsert must omit updated_at, or a reconciliation poll would keep resetting
    // the very progress clock the sweep predicate falls back on.
    mockGetOrder.mockResolvedValue(prodigiOrder('Complete'));
    const calls = setup({
      poRow: { ...STORED, prodigi_status_stage: 'Complete' },
      claimRows: [],
    });

    const res = await handleProdigiCallback({ ...callbackBody(), id: 'evt-noop' }, ENV);

    expect(res.status).toBe(200);
    expect(calls.poUpserts).toHaveLength(1);
    expect(calls.poUpserts[0]).not.toHaveProperty('updated_at');
  });

  it('a stage change DOES refresh updated_at (meaningful provider progress)', async () => {
    mockGetOrder.mockResolvedValue(prodigiOrder('Complete'));
    const calls = setup({
      poRow: { ...STORED, prodigi_status_stage: 'InProgress' },
      claimRows: [],
    });

    await handleProdigiCallback({ ...callbackBody(), id: 'evt-progress' }, ENV);

    expect(calls.poUpserts[0]).toHaveProperty('updated_at');
  });

  it('never re-persists a non-https stored tracking_url, even as the fallback', async () => {
    mockGetOrder.mockResolvedValue({
      order: { ...prodigiOrder('Complete').order, shipments: [] },
    });
    const calls = setup({
      poRow: { ...STORED, tracking_url: 'javascript:alert(1)' },
      claimRows: [],
    });

    await handleProdigiCallback({ ...callbackBody(), id: 'evt-bad-url' }, ENV);

    expect(calls.poUpserts[0]).toMatchObject({ tracking_url: null });
  });
});

describe('handleProdigiCallback — signed-URL redaction in persisted payloads (M-14)', () => {
  const SIG = 'f'.repeat(64);
  const SIGNED_URL = `https://anna-ciok.studio/api/print-assets/asset-1?exp=1770000000&sig=${SIG}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockShipEmail.mockResolvedValue(undefined);
    mockGetOrder.mockResolvedValue({
      order: {
        ...prodigiOrder('Complete').order,
        items: [{ id: 'item-1', assets: [{ printArea: 'default', url: SIGNED_URL }] }],
      },
    });
  });

  it('prodigi_raw_json is persisted with sig redacted but path + exp kept', async () => {
    const calls = setup();

    const res = await handleProdigiCallback(callbackBody(), ENV);

    expect(res.status).toBe(200);
    const raw = JSON.stringify(calls.poUpserts[0].prodigi_raw_json);
    expect(raw).not.toContain(SIG);
    expect(raw).toContain('/api/print-assets/asset-1');
    expect(raw).toContain('exp=1770000000');
  });

  it('webhook_events.raw_json (the inbound body) is persisted with sig redacted', async () => {
    const calls = setup();
    const body = {
      ...callbackBody(),
      data: {
        prodigiOrderId: 'pr_1',
        order: { id: 'pr_1', items: [{ assets: [{ url: SIGNED_URL }] }] },
      },
    };

    const res = await handleProdigiCallback(body, ENV);

    expect(res.status).toBe(200);
    expect(calls.eventInserts).toHaveLength(1);
    const raw = JSON.stringify(calls.eventInserts[0].raw_json);
    expect(raw).not.toContain(SIG);
    expect(raw).toContain('exp=1770000000');
  });
});

describe('handleProdigiCallback — real Prodigi CloudEvents shape (F-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrder.mockResolvedValue(prodigiOrder('Complete'));
    mockShipEmail.mockResolvedValue(undefined);
  });

  /** The shape Prodigi actually sends (Plan 05 rehearsal + v4 docs): the order
   *  object rides in `data.order`, and `subject` carries the order id. */
  function realCallbackBody(stage = 'Complete') {
    return {
      specversion: '1.0',
      id: 'evt-real-1',
      type: 'com.prodigi.order.status.stage#changed',
      source: 'http://api.prodigi.com/v4.0/Orders/',
      subject: 'pr_1',
      time: '2026-08-13T13:28:05Z',
      datacontenttype: 'application/json',
      data: {
        order: {
          id: 'pr_1',
          merchantReference: 'o1',
          status: { stage },
          items: [],
        },
      },
    };
  }

  it('accepts data.order (real shape) and processes to done', async () => {
    const calls = setup();

    const res = await handleProdigiCallback(realCallbackBody(), ENV);

    expect(res.status).toBe(200);
    expect(mockGetOrder).toHaveBeenCalledExactlyOnceWith('pr_1');
    expect(calls.eventUpdates.at(-1)).toMatchObject({ status: 'done' });
  });

  it('falls back to the CloudEvents subject when data carries no order id', async () => {
    const calls = setup();

    const res = await handleProdigiCallback(
      { ...realCallbackBody(), data: { unexpected: true } },
      ENV,
    );

    expect(res.status).toBe(200);
    expect(mockGetOrder).toHaveBeenCalledExactlyOnceWith('pr_1');
    expect(calls.eventUpdates.at(-1)).toMatchObject({ status: 'done' });
  });

  it('a rejected callback leaves a structured log trace (no more silent 400s)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setup();

    const res = await handleProdigiCallback({ id: 'evt-x', type: 't', data: {} }, ENV);

    expect(res.status).toBe(400);
    const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('prodigi_callback_rejected');
    expect(logged).toContain('evt-x');
    consoleErrorSpy.mockRestore();
  });
});

describe('handleProdigiCallback — dedup, mapping, error paths (Finding 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrder.mockResolvedValue(prodigiOrder('InProduction'));
    mockShipEmail.mockResolvedValue(undefined);
  });

  it('rejects a non-CloudEvents body with 400', async () => {
    setup();
    const res = await handleProdigiCallback({ hello: 'world' }, ENV);
    expect(res.status).toBe(400);
    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it('rejects a callback without data.prodigiOrderId with 400', async () => {
    setup();
    const res = await handleProdigiCallback({ id: 'evt-x', type: 't', data: {} }, ENV);
    expect(res.status).toBe(400);
  });

  it('an in-flight lease (fresh processing claim) short-circuits with 200 and no reprocessing', async () => {
    setup({
      existingEvent: { id: 'we-1', status: 'processing', processing_started_at: new Date().toISOString() },
    });
    const res = await handleProdigiCallback(callbackBody('InProduction'), ENV);
    expect(res.status).toBe(200);
    expect(res.message).toBe('In flight');
    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it('takes over an event whose processing lease has expired (stale CAS takeover)', async () => {
    // Catches a regression where a stale lease is skipped like a fresh one:
    // if the takeover branch regressed (e.g. the age check used `>=` or the
    // guard returned 'In flight' for stale leases too), getOrder would NOT be
    // called and the event would never reach 'done'.
    // Stale by one minute past the real lease window — value imported from callbacks.ts
    // so the test tracks the source constant instead of mirroring it.
    const staleStartedAt = new Date(Date.now() - (LEASE_MINUTES + 1) * 60_000).toISOString();
    const calls = setup({
      existingEvent: { id: 'we-1', status: 'processing', processing_started_at: staleStartedAt },
    });

    const res = await handleProdigiCallback(callbackBody('InProduction'), ENV);

    expect(res.status).toBe(200);
    expect(res.message).toBe('OK');
    expect(mockGetOrder).toHaveBeenCalledTimes(1); // proceeded past the lease guard
    expect(calls.eventUpdates.at(-1)).toMatchObject({ status: 'done' });
  });

  it('maps the Prodigi stage onto the latest fulfilment job (InProduction → in_production)', async () => {
    const calls = setup({ jobRow: { id: 'j1', status: 'fulfilment_submitted' } });
    const res = await handleProdigiCallback(callbackBody('InProduction'), ENV);
    expect(res.status).toBe(200);
    expect(calls.jobUpdates).toHaveLength(1);
    expect(calls.jobUpdates[0]).toMatchObject({ status: 'in_production' });
    expect(calls.eventUpdates.at(-1)).toMatchObject({ status: 'done' });
  });

  it('never downgrades a terminal job status', async () => {
    const calls = setup({ jobRow: { id: 'j1', status: 'shipped' } });
    const res = await handleProdigiCallback(callbackBody('InProduction'), ENV);
    expect(res.status).toBe(200);
    expect(calls.jobUpdates).toHaveLength(0);
  });

  it('unknown local order (no mapping, no merchantReference match) → 500 and the claim is released for retry', async () => {
    mockGetOrder.mockResolvedValue({
      order: { ...prodigiOrder('InProduction').order, merchantReference: 'missing' },
    });
    const calls = setup({ poRow: null, orderRow: null });
    const res = await handleProdigiCallback(callbackBody('InProduction'), ENV);
    expect(res.status).toBe(500);
    // releaseClaim marks the event 'failed' so Prodigi's retry can re-claim it.
    expect(calls.eventUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('Prodigi re-fetch failure → 500 with the claim released', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetOrder.mockRejectedValue(new Error('prodigi down'));
    const calls = setup();
    const res = await handleProdigiCallback(callbackBody('InProduction'), ENV);
    expect(res.status).toBe(500);
    expect(calls.eventUpdates.at(-1)).toMatchObject({ status: 'failed' });
    consoleErrorSpy.mockRestore();
  });
});
