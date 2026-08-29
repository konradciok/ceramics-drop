import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { ProdigiError } from './client';
import {
  loadCliEnv,
  parseCliArgs,
  redactPii,
  runCli,
  type CliDependencies,
} from '../../../scripts/prodigi-cli';

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

const TEST_CWD = resolve('/repo');

function harness(options: {
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  stdin?: string;
  result?: unknown;
  failure?: unknown;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let selectedEnv: CloudflareEnv | undefined;
  const method = (name: string) => vi.fn(async (...args: unknown[]) => {
    calls.push({ method: name, args });
    if (options.failure) throw options.failure;
    return options.result ?? { outcome: 'Ok' };
  });
  const client = {
    postOrder: method('postOrder'), getOrder: method('getOrder'), listOrders: method('listOrders'),
    getOrderActions: method('getOrderActions'), cancelOrder: method('cancelOrder'),
    updateShippingMethod: method('updateShippingMethod'), updateRecipient: method('updateRecipient'),
    updateMetadata: method('updateMetadata'), getProduct: method('getProduct'),
    postQuote: method('postQuote'), postSpine: method('postSpine'),
  };
  const cwd = TEST_CWD;
  const files = options.files ?? {};
  const deps: Partial<CliDependencies> = {
    cwd,
    env: { NODE_ENV: 'test', PRODIGI_API_KEY_SANDBOX: 'sandbox-secret', ...options.env },
    readTextFile: async (path) => {
      if (path in files) return files[path];
      throw missingFile();
    },
    readStdin: async () => options.stdin ?? '',
    clientFactory: ((env: CloudflareEnv) => {
      selectedEnv = env;
      return client;
    }) as unknown as CliDependencies['clientFactory'],
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { deps, stdout, stderr, calls, client, selectedEnv: () => selectedEnv };
}

describe('Prodigi CLI', () => {
  it('parses repeated list filters and rejects unknown arguments', () => {
    expect(parseCliArgs(['order', 'list', '--order-id', 'a', '--order-id', 'b']).options['order-id'])
      .toEqual(['a', 'b']);
    expect(() => parseCliArgs(['--no-such-option'])).toThrow();
  });

  it('loads env in documented precedence order', async () => {
    const h = harness({
      env: { PRODIGI_API_KEY_SANDBOX: 'process' },
      files: {
        [resolve(TEST_CWD, '.env.local')]: 'PRODIGI_API_KEY_SANDBOX=local\nLOCAL_ONLY=yes',
        [resolve(TEST_CWD, '.dev.vars')]: 'PRODIGI_API_KEY_SANDBOX=dev',
        [resolve(TEST_CWD, 'custom.env')]: 'PRODIGI_API_KEY_SANDBOX=explicit',
      },
    });
    const env = await loadCliEnv('custom.env', { ...h.deps } as CliDependencies);
    expect(env.PRODIGI_API_KEY_SANDBOX).toBe('process');
    expect(env.LOCAL_ONLY).toBe('yes');
  });

  it('defaults to sandbox and ignores PRODIGI_ENV', async () => {
    const h = harness({ env: { PRODIGI_ENV: 'live', PRODIGI_API_KEY_SANDBOX: 'sb' } });
    expect(await runCli(['product', 'get', 'SKU'], h.deps)).toBe(0);
    expect(h.selectedEnv()?.PRODIGI_ENV).toBe('sandbox');
    expect(h.calls[0]).toEqual({ method: 'getProduct', args: ['SKU'] });
  });

  it('selects only the live key when --live is explicit', async () => {
    const h = harness({ env: { PRODIGI_API_KEY_LIVE: 'live-secret' } });
    expect(await runCli(['--live', 'product', 'get', 'SKU'], h.deps)).toBe(0);
    expect(h.selectedEnv()?.PRODIGI_ENV).toBe('live');
    expect(h.selectedEnv()?.PRODIGI_API_KEY_LIVE).toBe('live-secret');
  });

  it('reads one JSON document from stdin and validates a quote', async () => {
    const payload = {
      destinationCountryCode: 'PL',
      items: [{ sku: 'GLOBAL-CFPM-16X20', copies: 1, assets: [{ printArea: 'default' }] }],
    };
    const h = harness({ stdin: JSON.stringify(payload) });
    expect(await runCli(['quote', 'create', '--file', '-'], h.deps)).toBe(0);
    expect(h.calls[0]).toEqual({ method: 'postQuote', args: [payload] });
  });

  it('reads a JSON payload from a repository-relative file', async () => {
    const payload = {
      sku: 'BOOK-A4-L-HARD-M',
      destinationCountryCode: 'PL',
      numberOfPages: 50,
    };
    const h = harness({ files: { [resolve(TEST_CWD, 'spine.json')]: JSON.stringify(payload) } });
    expect(await runCli(['product', 'spine', '--file', 'spine.json'], h.deps)).toBe(0);
    expect(h.calls[0]).toEqual({ method: 'postSpine', args: [payload] });
  });

  it('maps invalid JSON and invalid list values to exit 2', async () => {
    const invalidJson = harness({ stdin: '{' });
    expect(await runCli(['quote', 'create', '--file', '-'], invalidJson.deps)).toBe(2);
    expect(JSON.parse(invalidJson.stderr[0]).error.code).toBe('invalid_json');

    const invalidTop = harness();
    expect(await runCli(['order', 'list', '--top', '0'], invalidTop.deps)).toBe(2);
    expect(JSON.parse(invalidTop.stderr[0]).error.code).toBe('invalid_arguments');

    const excessiveTop = harness();
    expect(await runCli(['order', 'list', '--top', '101'], excessiveTop.deps)).toBe(2);
  });

  it('accepts documented successful non-Ok results and rejects a failed spine response', async () => {
    const onHold = harness({ result: { outcome: 'OnHold', order: { id: 'ord_1' } } });
    expect(await runCli(['order', 'get', 'ord_1'], onHold.deps)).toBe(0);

    const failedSpine = harness({
      stdin: JSON.stringify({
        sku: 'BOOK-A4-L-HARD-M',
        destinationCountryCode: 'PL',
        numberOfPages: 50,
      }),
      result: { success: false, message: 'Unsupported configuration' },
    });
    expect(await runCli(['product', 'spine', '--file', '-'], failedSpine.deps)).toBe(5);
  });

  it('blocks live creates and requires an exact live mutation confirmation', async () => {
    const create = harness({ env: { PRODIGI_API_KEY_LIVE: 'live' } });
    expect(await runCli(['--live', 'order', 'create', '--file', '-'], create.deps)).toBe(3);
    expect(JSON.parse(create.stderr[0]).error.code).toBe('live_order_create_disabled');

    const update = harness({ env: { PRODIGI_API_KEY_LIVE: 'live' } });
    expect(await runCli([
      '--live', 'order', 'update-shipping', 'ord_1', '--method', 'Standard', '--confirm-live', 'ord_2',
    ], update.deps)).toBe(3);
    expect(update.calls).toHaveLength(0);
  });

  it.each([
    ['cancel', ['order', 'cancel', 'ord_1']],
    ['update-shipping', ['order', 'update-shipping', 'ord_1', '--method', 'Standard']],
    ['update-recipient', ['order', 'update-recipient', 'ord_1', '--file', '-']],
    ['update-metadata', [
      'order', 'update-metadata', 'ord_1', '--file', '-', '--replace-metadata',
    ]],
  ])('guards live order %s with the exact target ID', async (_action, command) => {
    const h = harness({ env: { NODE_ENV: 'test', PRODIGI_API_KEY_LIVE: 'live' } });
    expect(await runCli(['--live', ...command, '--confirm-live', 'ord_other'], h.deps)).toBe(3);
    expect(h.calls).toHaveLength(0);
  });

  it('requires the destructive metadata replacement acknowledgement', async () => {
    const h = harness({ stdin: '{"metadata":{"nested":{"value":1}}}' });
    expect(await runCli(['order', 'update-metadata', 'ord_1', '--file', '-'], h.deps)).toBe(3);
    expect(JSON.parse(h.stderr[0]).error.code).toBe('metadata_replace_required');
  });

  it('redacts order PII by default without masking unrelated carrier names', async () => {
    const response = {
      order: {
        recipient: {
          name: 'Customer', email: 'person@example.com', phoneNumber: '123',
          address: { line1: 'Secret street' },
        },
        shipments: [{ carrier: { name: 'DHL' } }],
      },
    };
    expect(redactPii(response)).toEqual({
      order: {
        recipient: {
          name: '[REDACTED]', email: '[REDACTED]', phoneNumber: '[REDACTED]', address: '[REDACTED]',
        },
        shipments: [{ carrier: { name: 'DHL' } }],
      },
    });
    const h = harness({ result: response });
    expect(await runCli(['order', 'get', 'ord_1'], h.deps)).toBe(0);
    expect(JSON.parse(h.stdout[0]).data.order.recipient.name).toBe('[REDACTED]');
  });

  it('redacts every recipient in an order list', async () => {
    const h = harness({ result: {
      outcome: 'Ok',
      orders: [
        { recipient: { name: 'First', email: 'first@example.com', address: { line1: 'One' } } },
        { recipient: { name: 'Second', phoneNumber: '123', address: { line1: 'Two' } } },
      ],
    } });
    expect(await runCli(['order', 'list'], h.deps)).toBe(0);
    const orders = JSON.parse(h.stdout[0]).data.orders;
    expect(orders[0].recipient.name).toBe('[REDACTED]');
    expect(orders[1].recipient.address).toBe('[REDACTED]');
  });

  it('maps a missing selected API key to configuration exit 3', async () => {
    const h = harness({ env: { PRODIGI_API_KEY_SANDBOX: undefined } });
    expect(await runCli(['product', 'get', 'SKU'], h.deps)).toBe(3);
    expect(JSON.parse(h.stderr[0]).error.code).toBe('missing_api_key');
  });

  it('returns full PII only with --show-pii', async () => {
    const h = harness({ result: { order: { recipient: { name: 'Customer', address: {} } } } });
    expect(await runCli(['--show-pii', 'order', 'get', 'ord_1'], h.deps)).toBe(0);
    expect(JSON.parse(h.stdout[0]).data.order.recipient.name).toBe('Customer');
  });

  it.each(['CreatedWithIssues', 'PartiallyUpdated', 'FailedToUpdate', 'ActionNotAvailable'])(
    'maps %s to exit 5 and redacts error data',
    async (outcome) => {
      const h = harness({ result: {
        outcome,
        order: { recipient: { name: 'Customer', address: { line1: 'Secret' } } },
      } });
      expect(await runCli(['order', 'get', 'ord_1'], h.deps)).toBe(5);
      const error = JSON.parse(h.stderr[0]);
      expect(error.error.code).toBe('prodigi_outcome');
      expect(error.error.details.order.recipient.name).toBe('[REDACTED]');
    },
  );

  it('maps HTTP and retryable errors to exit 4 without leaking response PII', async () => {
    const h = harness({ failure: new ProdigiError(
      'Prodigi 503: secret response',
      503,
      true,
      { order: { recipient: { name: 'Customer', address: { line1: 'Secret' } } } },
    ) });
    expect(await runCli(['order', 'get', 'ord_1'], h.deps)).toBe(4);
    const error = JSON.parse(h.stderr[0]).error;
    expect(error.message).toBe('Prodigi request failed with HTTP 503');
    expect(error.details.retryable).toBe(true);
    expect(error.details.body.order.recipient.name).toBe('[REDACTED]');
  });

  it('prints JSON help without requiring configuration', async () => {
    const h = harness({ env: {} });
    expect(await runCli(['--help'], h.deps)).toBe(0);
    expect(JSON.parse(h.stdout[0])).toMatchObject({ ok: true, environment: 'sandbox' });
  });
});
