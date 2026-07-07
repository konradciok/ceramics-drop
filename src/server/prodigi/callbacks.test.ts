import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockGetOrder, mockShipEmail } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockGetOrder: vi.fn(),
  mockShipEmail: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('./client', () => ({ prodigiClient: vi.fn(() => ({ getOrder: mockGetOrder })) }));
vi.mock('@/lib/email', () => ({ emailPrintShippingConfirmationToCustomer: mockShipEmail }));

import { handleProdigiCallback } from './callbacks';

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
  /** prodigi_orders lookup row; explicit null = unknown Prodigi order. */
  poRow?: { order_id: string } | null;
  jobRow?: { id: string; status: string } | null;
} = {}) {
  const calls = {
    shippingClaims: [] as Record<string, unknown>[],
    jobUpdates: [] as Record<string, unknown>[],
    eventUpdates: [] as Record<string, unknown>[],
  };
  mockFrom.mockImplementation((table: string) => {
    if (table === 'webhook_events') {
      return {
        select: () => makeChain({ data: opts.existingEvent ?? null, error: null }),
        insert: () => makeChain({ error: null }),
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
        upsert: () => makeChain({ error: null }),
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

  it('send failure: releases OUR claim (CAS on the claimed timestamp) and still completes', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockShipEmail.mockRejectedValue(new Error('resend down'));
    const calls = setup();

    const res = await handleProdigiCallback(callbackBody(), ENV);

    expect(res.status).toBe(200);
    expect(calls.shippingClaims).toHaveLength(2);
    expect(typeof calls.shippingClaims[0].shipping_email_sent_at).toBe('string');
    expect(calls.shippingClaims[1].shipping_email_sent_at).toBeNull();
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
