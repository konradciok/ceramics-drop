import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
  listOrders: vi.fn(),
  listInventory: vi.fn(),
  refundOrder: vi.fn(),
  releaseReservation: vi.fn(),
  resendOrderConfirmation: vi.fn(),
  createShipmentForOrder: vi.fn(),
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

vi.mock('../src/lib/admin/data', () => ({
  getOrder: mocks.getOrder,
  listOrders: mocks.listOrders,
  listInventory: mocks.listInventory,
  isUuid: (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s),
  ORDER_STATUSES: ['pending', 'paid', 'failed', 'expired', 'refunded'],
}));
vi.mock('../src/lib/admin/actions', () => ({
  refundOrder: mocks.refundOrder,
  releaseReservation: mocks.releaseReservation,
  resendOrderConfirmation: mocks.resendOrderConfirmation,
  createShipmentForOrder: mocks.createShipmentForOrder,
}));

import {
  loadCliEnv,
  parseCliArgs,
  redactPii,
  runCli,
  type CliDependencies,
} from './orders-cli';
import { HANDLED_STRIPE_EVENTS } from '../src/lib/webhook';

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

const ORDER_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID = '00000000-0000-0000-0000-000000000002';
const PROD_URL = 'https://wnlysejenowymjdxlnaq.supabase.co';
const NONPROD_URL = 'https://some-other-project.supabase.co';
const TEST_CWD = resolve('/repo');

function harness(options: {
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const supabaseCalls: Array<{ url: string; key: string }> = [];
  const stripeCalls: string[] = [];
  const inpostCalls: unknown[] = [];
  const fakeSupabase = { tag: 'supabase' };
  const fakeStripe = { tag: 'stripe' };
  const fakeInpost = { tag: 'inpost' };
  const cwd = TEST_CWD;
  const files = options.files ?? {};
  const deps: Partial<CliDependencies> = {
    cwd,
    env: { NODE_ENV: 'test', ...options.env },
    readTextFile: async (path: string) => {
      if (path in files) return files[path];
      throw missingFile();
    },
    supabaseFactory: (url: string, key: string) => {
      supabaseCalls.push({ url, key });
      return fakeSupabase as never;
    },
    stripeFactory: (key: string) => {
      stripeCalls.push(key);
      return fakeStripe as never;
    },
    inpostFactory: (env: unknown) => {
      inpostCalls.push(env);
      return fakeInpost as never;
    },
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  };
  return { deps: deps as CliDependencies, stdout, stderr, supabaseCalls, stripeCalls, inpostCalls, fakeSupabase, fakeStripe, fakeInpost };
}

function lastJson(lines: string[]): { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } } {
  return JSON.parse(lines[lines.length - 1]) as never;
}

describe('orders-cli arg parsing', () => {
  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--no-such-flag'])).toThrow();
  });

  it('parses resource/action/id positionals plus options', () => {
    const { options, positionals } = parseCliArgs([
      'order', 'refund', ORDER_ID, '--confirm', ORDER_ID, '--show-pii', '--compact',
    ]);
    expect(positionals).toEqual(['order', 'refund', ORDER_ID]);
    expect(options.confirm).toBe(ORDER_ID);
    expect(options['show-pii']).toBe(true);
    expect(options.compact).toBe(true);
  });
});

describe('orders-cli env loading', () => {
  it('loads env in documented precedence order: .env.local < .dev.vars < --env-file < process.env', async () => {
    const h = harness({
      env: { SUPABASE_URL: 'process-value' },
      files: {
        [resolve(TEST_CWD, '.env.local')]: 'SUPABASE_URL=local\nLOCAL_ONLY=yes',
        [resolve(TEST_CWD, '.dev.vars')]: 'SUPABASE_URL=dev',
        [resolve(TEST_CWD, 'custom.env')]: 'SUPABASE_URL=explicit',
      },
    });
    const env = await loadCliEnv('custom.env', h.deps);
    expect(env.SUPABASE_URL).toBe('process-value');
    expect(env.LOCAL_ONLY).toBe('yes');
  });

  it('falls back gracefully when no env files exist', async () => {
    const h = harness({ env: { SUPABASE_URL: 'only-process' } });
    const env = await loadCliEnv(undefined, h.deps);
    expect(env.SUPABASE_URL).toBe('only-process');
  });
});

describe('redactPii', () => {
  it('redacts email/name/phone/address keys and leaves everything else', () => {
    const input = {
      id: ORDER_ID,
      email: 'buyer@example.com',
      receiver_first_name: 'Ada',
      receiver_phone: '+48123123123',
      shipping_address: { street: 'Main St' },
      status: 'paid',
      items: [{ product_id: 'k01' }],
    };
    expect(redactPii(input)).toEqual({
      id: ORDER_ID,
      email: '[REDACTED]',
      receiver_first_name: '[REDACTED]',
      receiver_phone: '[REDACTED]',
      shipping_address: '[REDACTED]',
      status: 'paid',
      items: [{ product_id: 'k01' }],
    });
  });
});

describe('runCli — usage and validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prints usage and exits 0 for --help or no arguments', async () => {
    const h = harness();
    const code = await runCli([], h.deps);
    expect(code).toBe(0);
    expect(lastJson(h.stdout).ok).toBe(true);
    expect((lastJson(h.stdout).data as { usage: string }).usage).toContain('order get <uuid>');
  });

  it('exits 2 for an unknown command', async () => {
    const h = harness();
    const code = await runCli(['nonsense', 'thing'], h.deps);
    expect(code).toBe(2);
    expect(lastJson(h.stderr).error?.code).toBe('unknown_command');
  });

  it('exits 2 when order get is given an invalid uuid', async () => {
    const h = harness();
    const code = await runCli(['order', 'get', 'not-a-uuid'], h.deps);
    expect(code).toBe(2);
    expect(lastJson(h.stderr).error?.code).toBe('invalid_arguments');
  });
});

describe('runCli — order get / order list / inventory list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches an order with the injected Supabase client and redacts PII by default', async () => {
    const h = harness({ env: { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 'sk' } });
    mocks.getOrder.mockResolvedValue({ id: ORDER_ID, email: 'buyer@example.com', items: [] });

    const code = await runCli(['order', 'get', ORDER_ID], h.deps);

    expect(code).toBe(0);
    expect(mocks.getOrder).toHaveBeenCalledWith(ORDER_ID, { supabase: h.fakeSupabase });
    expect(h.supabaseCalls).toEqual([{ url: PROD_URL, key: 'k' }]);
    const data = lastJson(h.stdout).data as { order: { id: string; email: string } };
    expect(data.order.email).toBe('[REDACTED]');
  });

  it('reveals PII with --show-pii', async () => {
    const h = harness({ env: { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 'sk' } });
    mocks.getOrder.mockResolvedValue({ id: ORDER_ID, email: 'buyer@example.com', items: [] });

    const code = await runCli(['order', 'get', ORDER_ID, '--show-pii'], h.deps);

    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as { order: { email: string } };
    expect(data.order.email).toBe('buyer@example.com');
  });

  it('exits 4 when the order does not exist', async () => {
    const h = harness({ env: { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 'sk' } });
    mocks.getOrder.mockResolvedValue(null);

    const code = await runCli(['order', 'get', ORDER_ID], h.deps);

    expect(code).toBe(4);
    expect(lastJson(h.stderr).error?.code).toBe('not_found');
  });

  it('exits 3 when Supabase credentials are missing', async () => {
    const h = harness();
    const code = await runCli(['order', 'get', ORDER_ID], h.deps);
    expect(code).toBe(3);
    expect(lastJson(h.stderr).error?.code).toBe('missing_config');
  });

  it('order list validates --status and forwards the filter + --top slicing', async () => {
    const h = harness({ env: { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k' } });
    mocks.listOrders.mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }]);

    const bad = await runCli(['order', 'list', '--status', 'bogus'], h.deps);
    expect(bad).toBe(2);

    const code = await runCli(['order', 'list', '--status', 'paid', '--top', '2'], h.deps);
    expect(code).toBe(0);
    expect(mocks.listOrders).toHaveBeenCalledWith(
      { status: 'paid', email: undefined },
      { withItems: false, supabase: h.fakeSupabase },
    );
    expect((lastJson(h.stdout).data as unknown[]).length).toBe(2);
  });

  it('inventory list validates --status and filters the result', async () => {
    const h = harness({ env: { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k' } });
    mocks.listInventory.mockResolvedValue([
      { product_id: 'k01', status: 'available' },
      { product_id: 'k02', status: 'reserved' },
    ]);

    const bad = await runCli(['inventory', 'list', '--status', 'bogus'], h.deps);
    expect(bad).toBe(2);

    const code = await runCli(['inventory', 'list', '--status', 'reserved'], h.deps);
    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as Array<{ product_id: string }>;
    expect(data).toEqual([{ product_id: 'k02', status: 'reserved' }]);
  });
});

describe('runCli — mutation guards', () => {
  const envBase = { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 'sk' };

  beforeEach(() => vi.clearAllMocks());

  it('blocks a refund with no --confirm', async () => {
    const h = harness({ env: envBase });
    const code = await runCli(['order', 'refund', ORDER_ID], h.deps);
    expect(code).toBe(3);
    expect(lastJson(h.stderr).error?.code).toBe('confirmation_required');
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it('blocks a refund whose --confirm does not match the target id', async () => {
    const h = harness({ env: envBase });
    const code = await runCli(['order', 'refund', ORDER_ID, '--confirm', OTHER_ID], h.deps);
    expect(code).toBe(3);
    expect(lastJson(h.stderr).error?.code).toBe('confirmation_required');
  });

  it('blocks a mutation against a non-production Supabase project without --allow-nonprod', async () => {
    const h = harness({ env: { ...envBase, SUPABASE_URL: NONPROD_URL } });
    const code = await runCli(['order', 'refund', ORDER_ID, '--confirm', ORDER_ID], h.deps);
    expect(code).toBe(3);
    expect(lastJson(h.stderr).error?.code).toBe('nonprod_target_blocked');
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it('allows a mutation against a non-production project with --allow-nonprod', async () => {
    const h = harness({ env: { ...envBase, SUPABASE_URL: NONPROD_URL } });
    mocks.refundOrder.mockResolvedValue({ status: 200, body: { message: 'ok' } });

    const code = await runCli(['order', 'refund', ORDER_ID, '--confirm', ORDER_ID, '--allow-nonprod'], h.deps);

    expect(code).toBe(0);
    expect(mocks.refundOrder).toHaveBeenCalledWith(
      { supabase: h.fakeSupabase, stripe: h.fakeStripe, env: expect.objectContaining({ SUPABASE_URL: NONPROD_URL }) },
      ORDER_ID,
    );
  });

  it('allows a mutation against the expected production project without --allow-nonprod', async () => {
    const h = harness({ env: envBase });
    mocks.refundOrder.mockResolvedValue({ status: 200, body: { message: 'ok' } });

    const code = await runCli(['order', 'refund', ORDER_ID, '--confirm', ORDER_ID], h.deps);

    expect(code).toBe(0);
  });

  it('maps a 4xx action failure to exit 4', async () => {
    const h = harness({ env: envBase });
    mocks.refundOrder.mockResolvedValue({ status: 409, body: { error: 'already refunded' } });
    const code = await runCli(['order', 'refund', ORDER_ID, '--confirm', ORDER_ID], h.deps);
    expect(code).toBe(4);
    expect(lastJson(h.stderr).error?.message).toBe('already refunded');
  });

  it('maps a 5xx action failure to exit 5', async () => {
    const h = harness({ env: envBase });
    mocks.refundOrder.mockResolvedValue({ status: 502, body: { error: 'stripe down' } });
    const code = await runCli(['order', 'refund', ORDER_ID, '--confirm', ORDER_ID], h.deps);
    expect(code).toBe(5);
  });

  it('release-reservation and resend-confirmation route to their actions', async () => {
    const h = harness({ env: envBase });
    mocks.releaseReservation.mockResolvedValue({ status: 200, body: { message: 'freed' } });
    mocks.resendOrderConfirmation.mockResolvedValue({ status: 200, body: { message: 'sent' } });

    const code1 = await runCli(['order', 'release-reservation', ORDER_ID, '--confirm', ORDER_ID], h.deps);
    expect(code1).toBe(0);
    expect(mocks.releaseReservation).toHaveBeenCalledWith({ supabase: h.fakeSupabase, stripe: h.fakeStripe }, ORDER_ID);

    const code2 = await runCli(['order', 'resend-confirmation', ORDER_ID, '--confirm', ORDER_ID], h.deps);
    expect(code2).toBe(0);
    expect(mocks.resendOrderConfirmation).toHaveBeenCalledWith(
      { supabase: h.fakeSupabase, env: expect.objectContaining({ SUPABASE_URL: PROD_URL }) },
      ORDER_ID,
    );
  });

  it('create-shipment builds an InPost client and forwards --recreate', async () => {
    const h = harness({ env: envBase });
    mocks.createShipmentForOrder.mockResolvedValue({ status: 200, body: { message: 'Nowa przesyłka utworzona.' } });

    const code = await runCli(['order', 'create-shipment', ORDER_ID, '--recreate', '--confirm', ORDER_ID], h.deps);

    expect(code).toBe(0);
    expect(h.inpostCalls).toHaveLength(1);
    expect(mocks.createShipmentForOrder).toHaveBeenCalledWith(
      { supabase: h.fakeSupabase, inpost: h.fakeInpost },
      ORDER_ID,
      { recreate: true },
    );
  });
});

describe('runCli — webhook-config-check', () => {
  const SDK_VERSION = '2026-05-27.dahlia';

  function wcEndpoint(overrides: Record<string, unknown> = {}) {
    return {
      id: 'we_prod',
      url: 'https://anna-ciok.studio/api/stripe/webhook',
      status: 'enabled',
      api_version: SDK_VERSION,
      enabled_events: [...HANDLED_STRIPE_EVENTS],
      ...overrides,
    };
  }

  function stripeWithEndpoints(endpoints: unknown[]) {
    return {
      getApiField: (key: string) => (key === 'version' ? SDK_VERSION : undefined),
      webhookEndpoints: { list: vi.fn(async () => ({ data: endpoints })) },
    };
  }

  function wcHarness(endpoints: unknown[]) {
    const h = harness({ env: { STRIPE_SECRET_KEY: 'sk' } });
    h.deps.stripeFactory = () => stripeWithEndpoints(endpoints) as never;
    return h;
  }

  beforeEach(() => vi.clearAllMocks());

  it('passes when the prod endpoint subscribes a superset with matching version, warning on unhandled extras', async () => {
    const h = wcHarness([
      wcEndpoint({ enabled_events: [...HANDLED_STRIPE_EVENTS, 'payment_intent.created'] }),
      // Non-prod-host and disabled endpoints must be ignored entirely.
      wcEndpoint({ id: 'we_other', url: 'https://example.com/hook', enabled_events: [] }),
      wcEndpoint({ id: 'we_disabled', status: 'disabled', enabled_events: [] }),
    ]);
    const code = await runCli(['webhook-config-check'], h.deps);
    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as {
      sdkApiVersion: string;
      endpoints: Array<{ id: string; ok: boolean; subscribedButUnhandled: string[] }>;
    };
    expect(data.sdkApiVersion).toBe(SDK_VERSION);
    expect(data.endpoints).toHaveLength(1);
    expect(data.endpoints[0].id).toBe('we_prod');
    expect(data.endpoints[0].ok).toBe(true);
    expect(data.endpoints[0].subscribedButUnhandled).toEqual(['payment_intent.created']);
    expect(h.supabaseCalls).toHaveLength(0);
  });

  it('fails naming the missing event when charge.refunded is not subscribed', async () => {
    const events = [...HANDLED_STRIPE_EVENTS].filter((e) => e !== 'charge.refunded');
    const h = wcHarness([wcEndpoint({ enabled_events: events })]);
    const code = await runCli(['webhook-config-check'], h.deps);
    expect(code).toBe(4);
    const err = lastJson(h.stderr).error;
    expect(err?.code).toBe('webhook_config_drift');
    expect(err?.message).toContain('charge.refunded');
  });

  it('fails on an endpoint/SDK API-version mismatch', async () => {
    const h = wcHarness([wcEndpoint({ api_version: '2025-03-31.basil' })]);
    const code = await runCli(['webhook-config-check'], h.deps);
    expect(code).toBe(4);
    const err = lastJson(h.stderr).error;
    expect(err?.code).toBe('webhook_config_drift');
    expect(err?.message).toContain('2025-03-31.basil');
    expect(err?.message).toContain(SDK_VERSION);
  });

  it('fails when no enabled endpoint matches the prod host', async () => {
    const h = wcHarness([wcEndpoint({ url: 'https://staging.example.com/api/stripe/webhook' })]);
    const code = await runCli(['webhook-config-check'], h.deps);
    expect(code).toBe(4);
    expect(lastJson(h.stderr).error?.code).toBe('webhook_config_drift');
  });
});

describe('runCli — prodigi-env-check', () => {
  type PecCall = { table: string; method: string; args: unknown[] };
  type PecPlan = {
    jobs?: unknown[];
    jobsError?: { message: string } | null;
    orders?: unknown[];
    ordersError?: { message: string } | null;
  };

  /** Minimal chainable Supabase fake tailored to prodigiEnvCheck's two queries. Pages a single response — enough for fixtures under FULFILMENT_JOBS_PAGE_SIZE (1000). */
  function fakeProdigiEnvDb(plan: PecPlan) {
    const calls: PecCall[] = [];
    const track = (table: string, method: string, args: unknown[]) => calls.push({ table, method, args });
    const jobsBuilder = () => {
      const b: Record<string, unknown> = {
        select: (...a: unknown[]) => { track('fulfilment_jobs', 'select', a); return b; },
        order: (...a: unknown[]) => { track('fulfilment_jobs', 'order', a); return b; },
        gte: (...a: unknown[]) => { track('fulfilment_jobs', 'gte', a); return b; },
        range: (...a: unknown[]) => {
          track('fulfilment_jobs', 'range', a);
          const [from, to] = a as [number, number];
          const page = (plan.jobs ?? []).slice(from, to + 1);
          return { then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: page, error: plan.jobsError ?? null }).then(res, rej) };
        },
      };
      return b;
    };
    const ordersBuilder = () => {
      const b: Record<string, unknown> = {
        select: (...a: unknown[]) => { track('orders', 'select', a); return b; },
        in: (...a: unknown[]) => { track('orders', 'in', a); return b; },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: plan.orders ?? [], error: plan.ordersError ?? null }).then(res, rej),
      };
      return b;
    };
    return {
      from: (table: string) => {
        if (table === 'fulfilment_jobs') return jobsBuilder();
        if (table === 'orders') return ordersBuilder();
        throw new Error(`unexpected table: ${table}`);
      },
      calls,
    };
  }

  function pecHarness(options: {
    jobs?: unknown[];
    jobsError?: { message: string } | null;
    orders?: unknown[];
    ordersError?: { message: string } | null;
    /** payment_intent id → { livemode } fixture, or 'throw' to simulate a failed Stripe lookup. */
    piById?: Record<string, { livemode: boolean } | 'throw'>;
  }) {
    const h = harness({ env: { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 'sk' } });
    const db = fakeProdigiEnvDb(options);
    h.deps.supabaseFactory = () => db as never;
    const retrieve = vi.fn(async (id: string) => {
      const entry = (options.piById ?? {})[id];
      if (entry === 'throw') throw new Error('stripe down');
      if (!entry) throw new Error(`no PI fixture for ${id}`);
      return entry;
    });
    h.deps.stripeFactory = () => ({ paymentIntents: { retrieve } }) as never;
    return { ...h, db, retrieve };
  }

  const job = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-1',
    order_id: ORDER_ID,
    status: 'shipped',
    prodigi_env: 'sandbox',
    livemode: null,
    created_at: '2026-09-02T03:00:02Z',
    ...overrides,
  });

  beforeEach(() => vi.clearAllMocks());

  // ── primary path: persisted livemode, no Stripe call needed ──────────────

  it('flags a live payment enqueued under a non-live PRODIGI_ENV using the persisted livemode column (regression: order 63445e00 pattern) — no Stripe call needed', async () => {
    const h = pecHarness({ jobs: [job({ livemode: true })] });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(4);
    const err = lastJson(h.stderr).error;
    expect(err?.code).toBe('prodigi_env_mismatch');
    const anomalies = (err?.details as { anomalies: Array<{ orderId: string; problem: string }> }).anomalies;
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ orderId: ORDER_ID, problem: 'live_payment_nonlive_env' });
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it('flags a test-mode payment enqueued under PRODIGI_ENV=live using the persisted livemode column', async () => {
    const h = pecHarness({ jobs: [job({ prodigi_env: 'live', livemode: false })] });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(4);
    const anomalies = (lastJson(h.stderr).error?.details as { anomalies: Array<{ problem: string }> }).anomalies;
    expect(anomalies[0].problem).toBe('test_payment_live_env');
  });

  it('no anomaly when the persisted livemode matches prodigi_env', async () => {
    const h = pecHarness({ jobs: [job({ prodigi_env: 'live', livemode: true })] });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as { scanned: number; anomalies: unknown[] };
    expect(data.scanned).toBe(1);
    expect(data.anomalies).toEqual([]);
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it('a job with prodigi_env null is flagged as missing_prodigi_env regardless of livemode', async () => {
    const h = pecHarness({ jobs: [job({ prodigi_env: null, livemode: true })] });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(4);
    const anomalies = (lastJson(h.stderr).error?.details as { anomalies: Array<{ problem: string }> }).anomalies;
    expect(anomalies[0].problem).toBe('missing_prodigi_env');
  });

  // ── legacy fallback: livemode not persisted, falls back to Stripe ────────

  it('legacy row (livemode not persisted): Stripe lookup succeeds and confirms a mismatch', async () => {
    const h = pecHarness({
      jobs: [job()], // livemode: null
      orders: [{ id: ORDER_ID, payment_intent_id: 'pi_live_1' }],
      piById: { pi_live_1: { livemode: true } },
    });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(4);
    const anomalies = (lastJson(h.stderr).error?.details as { anomalies: Array<{ problem: string }> }).anomalies;
    expect(anomalies[0].problem).toBe('live_payment_nonlive_env');
  });

  it('legacy row: Stripe lookup succeeds and confirms no mismatch', async () => {
    const h = pecHarness({
      jobs: [job({ prodigi_env: 'live' })],
      orders: [{ id: ORDER_ID, payment_intent_id: 'pi_1' }],
      piById: { pi_1: { livemode: true } },
    });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as { anomalies: unknown[] };
    expect(data.anomalies).toEqual([]);
  });

  it('legacy row whose order has no payment_intent_id is reported as modeless, never as an anomaly (e.g. gift-card/balance-only print)', async () => {
    const h = pecHarness({
      jobs: [job({ prodigi_env: 'live' })],
      orders: [{ id: ORDER_ID, payment_intent_id: null }],
    });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as { anomalies: unknown[]; modeless: Array<{ orderId: string }> };
    expect(data.anomalies).toEqual([]);
    expect(data.modeless).toEqual([{ orderId: ORDER_ID, jobId: 'job-1', jobStatus: 'shipped', prodigiEnv: 'live' }]);
  });

  it('a per-row Stripe lookup failure on a legacy row is reported as unverifiable, not a false anomaly and not a silent pass (a single Stripe key cannot retrieve a PaymentIntent from the opposite mode)', async () => {
    const h = pecHarness({
      jobs: [job({ prodigi_env: 'live' })],
      orders: [{ id: ORDER_ID, payment_intent_id: 'pi_broken' }],
      piById: { pi_broken: 'throw' },
    });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(0); // unverifiable never blocks the command — an unconfirmed row is not a confirmed anomaly
    const data = lastJson(h.stdout).data as {
      anomalies: unknown[];
      unverifiable: Array<{ orderId: string; reason: string; paymentIntentId: string }>;
    };
    expect(data.anomalies).toEqual([]);
    expect(data.unverifiable).toEqual([
      { orderId: ORDER_ID, jobId: 'job-1', jobStatus: 'shipped', prodigiEnv: 'live', paymentIntentId: 'pi_broken', reason: 'stripe_lookup_failed' },
    ]);
  });

  // ── pagination, --since, validation ───────────────────────────────────────

  it('pages past the 1000-row Supabase default so a large fulfilment_jobs table is never silently truncated', async () => {
    const jobs = Array.from({ length: 1001 }, (_, i) =>
      job({ id: `job-${i}`, order_id: `order-${i}`, livemode: true, prodigi_env: 'live', created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` }),
    );
    const h = pecHarness({ jobs });

    const code = await runCli(['prodigi-env-check'], h.deps);

    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as { scanned: number };
    expect(data.scanned).toBe(1001); // every row included, not truncated at the first 1000-row page
    const rangeCalls = h.db.calls.filter((c) => c.table === 'fulfilment_jobs' && c.method === 'range');
    expect(rangeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('--since is threaded through to the fulfilment_jobs query as a gte filter', async () => {
    const h = pecHarness({ jobs: [] });

    const code = await runCli(['prodigi-env-check', '--since', '2026-09-01T00:00:00Z'], h.deps);

    expect(code).toBe(0);
    expect(
      h.db.calls.some(
        (c) => c.table === 'fulfilment_jobs' && c.method === 'gte' && c.args[1] === '2026-09-01T00:00:00Z',
      ),
    ).toBe(true);
  });

  it('invalid --since (not a date at all) exits 2 invalid_arguments', async () => {
    const h = pecHarness({});

    const code = await runCli(['prodigi-env-check', '--since', 'not-a-date'], h.deps);

    expect(code).toBe(2);
    expect(lastJson(h.stderr).error?.code).toBe('invalid_arguments');
  });

  it('invalid --since (calendar overflow, e.g. February 30th) exits 2 invalid_arguments instead of silently normalizing to a different date', async () => {
    const h = pecHarness({});

    const code = await runCli(['prodigi-env-check', '--since', '2026-02-30'], h.deps);

    expect(code).toBe(2);
    expect(lastJson(h.stderr).error?.code).toBe('invalid_arguments');
  });

  it('a well-formed ISO date (with time and offset) is accepted', async () => {
    const h = pecHarness({ jobs: [] });

    const code = await runCli(['prodigi-env-check', '--since', '2026-09-01T12:30:00+02:00'], h.deps);

    expect(code).toBe(0);
  });
});

describe('runCli — reconcile-refunds', () => {
  type DbCall = {
    table: string;
    op: 'select' | 'update';
    payload?: unknown;
    filters: Array<[string, ...unknown[]]>;
  };

  type DbPlan = {
    orders?: unknown[];
    orderById?: unknown;
    piecesSold?: unknown[];
    jobs?: unknown[];
    prodigi?: unknown[];
    orderCasRows?: unknown[];
    relistRows?: unknown[];
  };

  /** Minimal chainable Supabase fake: records every terminal call, answers per table+op. */
  function fakeDb(plan: DbPlan) {
    const calls: DbCall[] = [];
    const respond = (call: DbCall): { data: unknown; error: null } => {
      if (call.table === 'orders' && call.op === 'select') {
        const byId = call.filters.some((f) => f[0] === 'eq' && f[1] === 'id');
        return { data: byId ? plan.orderById ?? null : plan.orders ?? [], error: null };
      }
      if (call.table === 'orders' && call.op === 'update') return { data: plan.orderCasRows ?? [], error: null };
      if (call.table === 'piece_state' && call.op === 'select') return { data: plan.piecesSold ?? [], error: null };
      if (call.table === 'piece_state' && call.op === 'update') return { data: plan.relistRows ?? [], error: null };
      if (call.table === 'fulfilment_jobs') return { data: plan.jobs ?? [], error: null };
      if (call.table === 'prodigi_orders') return { data: plan.prodigi ?? [], error: null };
      return { data: null, error: null };
    };
    const client = {
      from(table: string) {
        const call: DbCall = { table, op: 'select', filters: [] };
        const b: Record<string, unknown> = {
          select: () => b,
          update: (payload: unknown) => {
            call.op = 'update';
            call.payload = payload;
            return b;
          },
          eq: (...a: unknown[]) => {
            call.filters.push(['eq', ...a]);
            return b;
          },
          in: (...a: unknown[]) => {
            call.filters.push(['in', ...a]);
            return b;
          },
          is: (...a: unknown[]) => {
            call.filters.push(['is', ...a]);
            return b;
          },
          maybeSingle: async () => {
            calls.push(call);
            return respond(call);
          },
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
            calls.push(call);
            return Promise.resolve(respond(call)).then(res, rej);
          },
        };
        return b;
      },
    };
    return { client, calls };
  }

  const fullRefund = (id: string, pi: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status: 'succeeded',
    payment_intent: pi,
    charge: { id: `ch_${pi}`, amount: 1000, amount_refunded: 1000, payment_intent: pi },
    ...overrides,
  });

  function reconcileHarness(options: {
    db: DbPlan;
    refunds?: unknown[];
    piById?: Record<string, unknown>;
    env?: Record<string, string>;
  }) {
    const h = harness({
      env: { SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 'sk', ...options.env },
    });
    const db = fakeDb(options.db);
    h.deps.supabaseFactory = () => db.client as never;
    h.deps.stripeFactory = () =>
      ({
        refunds: { list: vi.fn(async () => ({ data: options.refunds ?? [], has_more: false })) },
        paymentIntents: {
          retrieve: vi.fn(async (id: string) => (options.piById ?? {})[id]),
        },
      }) as never;
    return { ...h, db };
  }

  const dbUpdates = (calls: DbCall[]) => calls.filter((c) => c.op === 'update');

  beforeEach(() => vi.clearAllMocks());

  it('dry-run reports unconverged orders, excludes partial refunds and converged orders, and writes nothing', async () => {
    const PI_BROKEN = 'pi_broken';
    const PI_PARTIAL = 'pi_partial';
    const PI_OK = 'pi_ok';
    const OK_ORDER = OTHER_ID;
    const h = reconcileHarness({
      refunds: [
        fullRefund('re_1', PI_BROKEN),
        fullRefund('re_2', PI_PARTIAL, { charge: { id: 'ch_p', amount: 1000, amount_refunded: 400, payment_intent: PI_PARTIAL } }),
        fullRefund('re_3', PI_OK),
      ],
      db: {
        orders: [
          { id: ORDER_ID, status: 'paid', payment_intent_id: PI_BROKEN, private_sale_id: null, conversions_sent_at: '2026-08-01T00:00:00Z' },
          { id: OK_ORDER, status: 'refunded', payment_intent_id: PI_OK, private_sale_id: null, conversions_sent_at: null },
        ],
        piecesSold: [{ order_id: ORDER_ID, product_id: 's15' }],
      },
    });

    const code = await runCli(['reconcile-refunds'], h.deps);

    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as {
      unreconciled: Array<{ orderId: string; problems: string[]; piecesStillSold: string[]; followUps: string[] }>;
    };
    expect(data.unreconciled).toHaveLength(1);
    expect(data.unreconciled[0].orderId).toBe(ORDER_ID);
    expect(data.unreconciled[0].problems).toContain('status_not_refunded');
    expect(data.unreconciled[0].problems).toContain('pieces_still_sold');
    expect(data.unreconciled[0].piecesStillSold).toEqual(['s15']);
    expect(data.unreconciled[0].followUps).toContain('ga4_refund_reversal');
    expect(dbUpdates(h.db.calls)).toHaveLength(0);
  });

  it('dry-run keeps reporting a refunded order whose Prodigi side is still active (partially-converged)', async () => {
    const h = reconcileHarness({
      refunds: [fullRefund('re_1', 'pi_print')],
      db: {
        orders: [{ id: ORDER_ID, status: 'refunded', payment_intent_id: 'pi_print', private_sale_id: null, conversions_sent_at: null }],
        prodigi: [{ order_id: ORDER_ID, prodigi_order_id: 'ord_123', prodigi_status_stage: 'InProgress', cancel_alerted_at: null }],
      },
    });

    const code = await runCli(['reconcile-refunds'], h.deps);

    expect(code).toBe(0);
    const data = lastJson(h.stdout).data as { unreconciled: Array<{ orderId: string; problems: string[] }> };
    expect(data.unreconciled).toHaveLength(1);
    expect(data.unreconciled[0].problems).toEqual(['prodigi_active']);
  });

  it('--confirm performs exactly the order CAS + scoped relist and emits REQUIRED FOLLOW-UP for Prodigi and GA4', async () => {
    const h = reconcileHarness({
      db: {
        orderById: { id: ORDER_ID, status: 'paid', payment_intent_id: 'pi_1', private_sale_id: null, conversions_sent_at: '2026-08-01T00:00:00Z' },
        orderCasRows: [{ id: ORDER_ID }],
        relistRows: [{ product_id: 's15' }],
        jobs: [{ order_id: ORDER_ID, status: 'queued' }],
      },
      piById: { pi_1: { id: 'pi_1', status: 'succeeded', latest_charge: { amount: 1000, amount_refunded: 1000 } } },
    });

    const code = await runCli(['reconcile-refunds', '--confirm', ORDER_ID], h.deps);

    expect(code).toBe(0);
    const updates = dbUpdates(h.db.calls);
    expect(updates).toHaveLength(2);
    expect(updates[0].table).toBe('orders');
    expect(updates[0].payload).toEqual({ status: 'refunded' });
    expect(updates[0].filters).toContainEqual(['eq', 'id', ORDER_ID]);
    expect(updates[0].filters).toContainEqual(['in', 'status', ['paid', 'pending']]);
    expect(updates[1].table).toBe('piece_state');
    expect(updates[1].payload).toEqual({ status: 'available', reserved_until: null, order_id: null });
    expect(updates[1].filters).toContainEqual(['eq', 'order_id', ORDER_ID]);
    expect(updates[1].filters).toContainEqual(['in', 'status', ['sold', 'reserved']]);
    const data = lastJson(h.stdout).data as {
      converged: boolean;
      relist: { outcome: string; pieces: string[] };
      requiredFollowUps: Array<{ kind: string }>;
    };
    expect(data.relist.outcome).toBe('relisted');
    expect(data.relist.pieces).toEqual(['s15']);
    expect(data.requiredFollowUps.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['prodigi_cancel', 'ga4_refund_reversal']),
    );
    expect(data.converged).toBe(false);
  });

  it('--confirm --skip-relist keeps pieces OFF sale: converges them to detached sold (private-sale terminal state), never available', async () => {
    const h = reconcileHarness({
      db: {
        orderById: { id: ORDER_ID, status: 'paid', payment_intent_id: 'pi_1', private_sale_id: null, conversions_sent_at: null },
        orderCasRows: [{ id: ORDER_ID }],
        relistRows: [{ product_id: 's15' }],
      },
      piById: { pi_1: { id: 'pi_1', status: 'succeeded', latest_charge: { amount: 1000, amount_refunded: 1000 } } },
    });

    const code = await runCli(['reconcile-refunds', '--confirm', ORDER_ID, '--skip-relist'], h.deps);

    expect(code).toBe(0);
    const updates = dbUpdates(h.db.calls);
    expect(updates).toHaveLength(2);
    expect(updates[0].table).toBe('orders');
    expect(updates[1].table).toBe('piece_state');
    expect(updates[1].payload).toEqual({ status: 'sold', reserved_until: null, order_id: null });
    expect(updates[1].filters).toContainEqual(['eq', 'order_id', ORDER_ID]);
    expect(updates[1].filters).toContainEqual(['in', 'status', ['sold', 'reserved']]);
    const data = lastJson(h.stdout).data as { relist: { outcome: string; pieces: string[] } };
    expect(data.relist.outcome).toBe('kept_off_sale');
    expect(data.relist.pieces).toEqual(['s15']);
  });

  it('--confirm on a private-sale order converges pieces to sold, never relists publicly', async () => {
    const h = reconcileHarness({
      db: {
        orderById: { id: ORDER_ID, status: 'paid', payment_intent_id: 'pi_1', private_sale_id: 'ps_1', conversions_sent_at: null },
        orderCasRows: [{ id: ORDER_ID }],
      },
      piById: { pi_1: { id: 'pi_1', status: 'succeeded', latest_charge: { amount: 1000, amount_refunded: 1000 } } },
    });

    const code = await runCli(['reconcile-refunds', '--confirm', ORDER_ID], h.deps);

    expect(code).toBe(0);
    const updates = dbUpdates(h.db.calls);
    expect(updates).toHaveLength(2);
    expect(updates[1].table).toBe('piece_state');
    expect(updates[1].payload).toEqual({ status: 'sold', reserved_until: null, order_id: null });
    expect(updates[1].filters).toContainEqual(['in', 'status', ['reserved']]);
    const data = lastJson(h.stdout).data as { relist: { outcome: string } };
    expect(data.relist.outcome).toBe('private_sale_converged');
  });

  it('--confirm refuses when the payment is not fully refunded in Stripe', async () => {
    const h = reconcileHarness({
      db: {
        orderById: { id: ORDER_ID, status: 'paid', payment_intent_id: 'pi_1', private_sale_id: null, conversions_sent_at: null },
      },
      piById: { pi_1: { id: 'pi_1', status: 'succeeded', latest_charge: { amount: 1000, amount_refunded: 400 } } },
    });

    const code = await runCli(['reconcile-refunds', '--confirm', ORDER_ID], h.deps);

    expect(code).toBe(4);
    expect(lastJson(h.stderr).error?.code).toBe('not_fully_refunded');
    expect(dbUpdates(h.db.calls)).toHaveLength(0);
  });

  it('--confirm is blocked against a non-production project without --allow-nonprod', async () => {
    const h = reconcileHarness({
      db: { orderById: { id: ORDER_ID, status: 'paid', payment_intent_id: 'pi_1', private_sale_id: null } },
      env: { SUPABASE_URL: NONPROD_URL },
    });

    const code = await runCli(['reconcile-refunds', '--confirm', ORDER_ID], h.deps);

    expect(code).toBe(3);
    expect(lastJson(h.stderr).error?.code).toBe('nonprod_target_blocked');
    expect(dbUpdates(h.db.calls)).toHaveLength(0);
  });
});
