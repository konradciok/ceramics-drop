import { describe, expect, it, vi, beforeEach } from 'vitest';

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

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

const ORDER_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID = '00000000-0000-0000-0000-000000000002';
const PROD_URL = 'https://wnlysejenowymjdxlnaq.supabase.co';
const NONPROD_URL = 'https://some-other-project.supabase.co';

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
  const cwd = '/repo';
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
        '/repo/.env.local': 'SUPABASE_URL=local\nLOCAL_ONLY=yes',
        '/repo/.dev.vars': 'SUPABASE_URL=dev',
        '/repo/custom.env': 'SUPABASE_URL=explicit',
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
