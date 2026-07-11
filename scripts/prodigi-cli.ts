#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ProdigiError, prodigiClient } from '../src/server/prodigi/client';

export type ProdigiEnvironment = 'sandbox' | 'live';

type Client = ReturnType<typeof prodigiClient>;

export interface CliDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  readTextFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  clientFactory(env: CloudflareEnv): Client;
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultDependencies: CliDependencies = {
  cwd: process.cwd(),
  env: process.env,
  readTextFile: (path) => readFile(path, 'utf8'),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
  clientFactory: prodigiClient,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4 | 5,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const nonEmpty = z.string().trim().min(1);
const recipientSchema = z.object({
  name: nonEmpty,
  email: z.string().optional(),
  phoneNumber: z.string().optional(),
  address: z.object({
    line1: nonEmpty,
    line2: z.string().optional(),
    postalOrZipCode: nonEmpty,
    countryCode: nonEmpty,
    townOrCity: nonEmpty,
    stateOrCounty: z.string().optional(),
  }).passthrough(),
}).passthrough();
const assetSchema = z.object({
  printArea: nonEmpty,
  url: nonEmpty,
  md5Hash: nonEmpty.optional(),
  pageCount: z.number().int().positive().optional(),
}).passthrough();
const itemSchema = z.object({
  sku: nonEmpty,
  copies: z.number().int().positive(),
  sizing: z.enum(['fillPrintArea', 'fitPrintArea', 'stretchToPrintArea']),
  attributes: z.record(z.string(), z.string()).optional(),
  assets: z.array(assetSchema).min(1),
  recipientCost: z.object({ amount: nonEmpty, currency: nonEmpty }).optional(),
}).passthrough();
const orderSchema = z.object({
  shippingMethod: nonEmpty,
  idempotencyKey: nonEmpty,
  merchantReference: nonEmpty,
  recipient: recipientSchema,
  items: z.array(itemSchema).min(1),
}).passthrough();
const quoteSchema = z.object({
  destinationCountryCode: nonEmpty,
  shippingMethod: z.string().optional(),
  currencyCode: z.string().optional(),
  items: z.array(z.object({
    sku: nonEmpty,
    copies: z.number().int().positive(),
    assets: z.array(z.object({ printArea: nonEmpty }).passthrough()).min(1),
    attributes: z.record(z.string(), z.string()).optional(),
  }).passthrough()).min(1),
}).passthrough();
const spineSchema = z.object({
  sku: nonEmpty,
  destinationCountryCode: nonEmpty,
  numberOfPages: z.number().int().positive(),
  state: z.string().optional(),
}).passthrough();
const metadataSchema = z.object({ metadata: z.record(z.string(), z.unknown()) }).strict();

const USAGE = `npm run prodigi -- [--live] [--env-file PATH] [--show-pii] [--compact] <resource> <action>

product get <sku>
product spine --file <path|->
quote create --file <path|->
order create --file <path|->
order get <ord_id>
order list [--top N] [--skip N] [--created-from ISO] [--created-to ISO]
           [--status STATUS] [--order-id ID...] [--merchant-reference REF...]
order actions <ord_id>
order cancel <ord_id>
order update-shipping <ord_id> --method METHOD
order update-recipient <ord_id> --file <path|->
order update-metadata <ord_id> --file <path|-> --replace-metadata`;

type ParsedOptions = {
  live?: boolean;
  'env-file'?: string;
  'show-pii'?: boolean;
  compact?: boolean;
  file?: string;
  top?: string;
  skip?: string;
  'created-from'?: string;
  'created-to'?: string;
  status?: string;
  'order-id'?: string[];
  'merchant-reference'?: string[];
  method?: string;
  'confirm-live'?: string;
  'replace-metadata'?: boolean;
  help?: boolean;
};

export function parseCliArgs(argv: string[]): { options: ParsedOptions; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        live: { type: 'boolean' },
        'env-file': { type: 'string' },
        'show-pii': { type: 'boolean' },
        compact: { type: 'boolean' },
        file: { type: 'string' },
        top: { type: 'string' },
        skip: { type: 'string' },
        'created-from': { type: 'string' },
        'created-to': { type: 'string' },
        status: { type: 'string' },
        'order-id': { type: 'string', multiple: true },
        'merchant-reference': { type: 'string', multiple: true },
        method: { type: 'string' },
        'confirm-live': { type: 'string' },
        'replace-metadata': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    return { options: parsed.values as ParsedOptions, positionals: parsed.positionals };
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 2, 'invalid_arguments');
  }
}

export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function optionalEnvFile(path: string, deps: CliDependencies): Promise<Record<string, string>> {
  try {
    return parseEnvText(await deps.readTextFile(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw new CliError(`Cannot read environment file ${path}`, 3, 'env_file_unreadable');
  }
}

export async function loadCliEnv(
  explicitPath: string | undefined,
  deps: CliDependencies,
): Promise<Record<string, string | undefined>> {
  const local = await optionalEnvFile(resolve(deps.cwd, '.env.local'), deps);
  const dev = await optionalEnvFile(resolve(deps.cwd, '.dev.vars'), deps);
  let explicit: Record<string, string> = {};
  if (explicitPath) {
    const resolved = resolve(deps.cwd, explicitPath);
    try {
      explicit = parseEnvText(await deps.readTextFile(resolved));
    } catch {
      throw new CliError(`Cannot read explicit environment file ${resolved}`, 3, 'env_file_unreadable');
    }
  }
  return { ...local, ...dev, ...explicit, ...deps.env };
}

async function readJson(path: string | undefined, deps: CliDependencies): Promise<unknown> {
  if (!path) throw new CliError('This command requires --file <path|->', 2, 'missing_file');
  let text: string;
  try {
    text = path === '-' ? await deps.readStdin() : await deps.readTextFile(resolve(deps.cwd, path));
  } catch {
    throw new CliError(`Cannot read JSON input ${path}`, 2, 'input_unreadable');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`Invalid JSON in ${path === '-' ? 'stdin' : path}`, 2, 'invalid_json');
  }
}

function validate<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new CliError(`Invalid ${label} payload`, 2, 'invalid_payload', result.error.flatten());
  }
  return result.data;
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliError(`${flag} must be a non-negative integer`, 2, 'invalid_arguments');
  }
  return parsed;
}

function topValue(value: string | undefined): number | undefined {
  const parsed = positiveInteger(value, '--top');
  if (parsed === 0) throw new CliError('--top must be a positive integer', 2, 'invalid_arguments');
  if (parsed !== undefined && parsed > 100) {
    throw new CliError('--top must not exceed 100', 2, 'invalid_arguments');
  }
  return parsed;
}

function isoDate(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!z.iso.datetime({ offset: true }).safeParse(value).success) {
    throw new CliError(`${flag} must be an ISO 8601 date-time with timezone`, 2, 'invalid_arguments');
  }
  return value;
}

function assertPositionals(positionals: string[], expected: number, usage: string): void {
  if (positionals.length !== expected) {
    throw new CliError(`Expected ${usage}`, 2, 'invalid_arguments');
  }
}

function requireLiveConfirmation(environment: ProdigiEnvironment, orderId: string, confirmation?: string): void {
  if (environment === 'live' && confirmation !== orderId) {
    throw new CliError(`Live mutation requires --confirm-live ${orderId}`, 3, 'live_confirmation_required');
  }
}

export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPii);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  const looksLikeRecipient = entries.some(([key]) => key === 'address')
    && entries.some(([key]) => ['name', 'email', 'phone', 'phoneNumber'].includes(key));
  const output: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (looksLikeRecipient && ['name', 'email', 'phone', 'phoneNumber', 'address'].includes(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    if (key === 'recipient' && child && typeof child === 'object' && !Array.isArray(child)) {
      output[key] = Object.fromEntries(Object.entries(child).map(([recipientKey, recipientValue]) => [
        recipientKey,
        ['name', 'email', 'phone', 'phoneNumber', 'address'].includes(recipientKey)
          ? '[REDACTED]'
          : redactPii(recipientValue),
      ]));
    } else output[key] = redactPii(child);
  }
  return output;
}

const SUCCESS_OUTCOMES = new Set(['ok', 'created', 'onhold', 'alreadyexists', 'updated', 'cancelled']);

function assertSuccessfulOutcome(result: unknown): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  const record = result as Record<string, unknown>;
  if (record.success === false) {
    throw new CliError('Prodigi returned success false', 5, 'prodigi_outcome', result);
  }
  const outcome = record.outcome;
  if (typeof outcome === 'string' && !SUCCESS_OUTCOMES.has(outcome.replace(/[\s_-]/g, '').toLowerCase())) {
    throw new CliError(`Prodigi returned outcome ${outcome}`, 5, 'prodigi_outcome', result);
  }
}

async function execute(
  positionals: string[],
  options: ParsedOptions,
  environment: ProdigiEnvironment,
  client: Client,
  deps: CliDependencies,
): Promise<unknown> {
  const [resource, action, id] = positionals;

  if (resource === 'product' && action === 'get') {
    assertPositionals(positionals, 3, 'product get <sku>');
    return client.getProduct(id);
  }
  if (resource === 'product' && action === 'spine') {
    assertPositionals(positionals, 2, 'product spine --file <path|->');
    return client.postSpine(validate(spineSchema, await readJson(options.file, deps), 'spine'));
  }
  if (resource === 'quote' && action === 'create') {
    assertPositionals(positionals, 2, 'quote create --file <path|->');
    return client.postQuote(validate(quoteSchema, await readJson(options.file, deps), 'quote'));
  }
  if (resource === 'order' && action === 'create') {
    assertPositionals(positionals, 2, 'order create --file <path|->');
    if (environment === 'live') {
      throw new CliError('Manual live order creation is disabled', 3, 'live_order_create_disabled');
    }
    return client.postOrder(validate(orderSchema, await readJson(options.file, deps), 'order'));
  }
  if (resource === 'order' && action === 'get') {
    assertPositionals(positionals, 3, 'order get <ord_id>');
    return client.getOrder(id);
  }
  if (resource === 'order' && action === 'list') {
    assertPositionals(positionals, 2, 'order list');
    const createdFrom = isoDate(options['created-from'], '--created-from');
    const createdTo = isoDate(options['created-to'], '--created-to');
    if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
      throw new CliError('--created-from must not be later than --created-to', 2, 'invalid_arguments');
    }
    if (options.status !== undefined && !options.status.trim()) {
      throw new CliError('--status must not be empty', 2, 'invalid_arguments');
    }
    return client.listOrders({
      top: topValue(options.top),
      skip: positiveInteger(options.skip, '--skip'),
      createdFrom,
      createdTo,
      status: options.status,
      orderIds: options['order-id'],
      merchantReferences: options['merchant-reference'],
    });
  }
  if (resource === 'order' && action === 'actions') {
    assertPositionals(positionals, 3, 'order actions <ord_id>');
    return client.getOrderActions(id);
  }
  if (resource === 'order' && action === 'cancel') {
    assertPositionals(positionals, 3, 'order cancel <ord_id>');
    requireLiveConfirmation(environment, id, options['confirm-live']);
    return client.cancelOrder(id);
  }
  if (resource === 'order' && action === 'update-shipping') {
    assertPositionals(positionals, 3, 'order update-shipping <ord_id> --method METHOD');
    requireLiveConfirmation(environment, id, options['confirm-live']);
    if (!options.method?.trim()) throw new CliError('Missing --method', 2, 'invalid_arguments');
    return client.updateShippingMethod(id, options.method);
  }
  if (resource === 'order' && action === 'update-recipient') {
    assertPositionals(positionals, 3, 'order update-recipient <ord_id> --file <path|->');
    requireLiveConfirmation(environment, id, options['confirm-live']);
    const recipient = validate(recipientSchema, await readJson(options.file, deps), 'recipient');
    return client.updateRecipient(id, recipient);
  }
  if (resource === 'order' && action === 'update-metadata') {
    assertPositionals(positionals, 3, 'order update-metadata <ord_id> --file <path|-> --replace-metadata');
    requireLiveConfirmation(environment, id, options['confirm-live']);
    if (!options['replace-metadata']) {
      throw new CliError('Metadata replacement requires --replace-metadata', 3, 'metadata_replace_required');
    }
    const metadata = validate(metadataSchema, await readJson(options.file, deps), 'metadata');
    return client.updateMetadata(id, metadata);
  }
  throw new CliError('Unknown command. Use --help for usage.', 2, 'unknown_command');
}

function serialized(value: unknown, compact: boolean): string {
  return `${JSON.stringify(value, null, compact ? undefined : 2)}\n`;
}

export async function runCli(argv: string[], overrides: Partial<CliDependencies> = {}): Promise<number> {
  const deps: CliDependencies = { ...defaultDependencies, ...overrides };
  let compact = false;
  let showPii = false;
  let environment: ProdigiEnvironment = 'sandbox';
  try {
    const { options, positionals } = parseCliArgs(argv);
    compact = options.compact ?? false;
    showPii = options['show-pii'] ?? false;
    environment = options.live ? 'live' : 'sandbox';
    if (options.help) {
      deps.stdout(serialized({ ok: true, environment, data: { usage: USAGE } }, compact));
      return 0;
    }
    const env = await loadCliEnv(options['env-file'], deps);
    const keyName = environment === 'live' ? 'PRODIGI_API_KEY_LIVE' : 'PRODIGI_API_KEY_SANDBOX';
    const apiKey = env[keyName];
    if (!apiKey) throw new CliError(`Missing ${keyName}`, 3, 'missing_api_key');

    // PRODIGI_ENV from files/process is deliberately ignored. The CLI chooses it
    // only from the explicit --live flag, and needs only the selected API key.
    const clientEnv = {
      PRODIGI_ENV: environment,
      PRODIGI_API_KEY_SANDBOX: environment === 'sandbox' ? apiKey : '',
      PRODIGI_API_KEY_LIVE: environment === 'live' ? apiKey : '',
    } as unknown as CloudflareEnv;
    const result = await execute(positionals, options, environment, deps.clientFactory(clientEnv), deps);
    assertSuccessfulOutcome(result);
    const data = showPii ? result : redactPii(result);
    deps.stdout(serialized({ ok: true, environment, data }, compact));
    return 0;
  } catch (error) {
    let normalized: CliError;
    if (error instanceof CliError) normalized = error;
    else if (error instanceof ProdigiError) {
      const message = error.status === null
        ? 'Prodigi network request failed'
        : `Prodigi request failed with HTTP ${error.status}`;
      normalized = new CliError(message, 4, 'prodigi_http', {
        status: error.status,
        retryable: error.retryable,
        body: error.body,
      });
    } else {
      normalized = new CliError(error instanceof Error ? error.message : String(error), 1, 'internal_error');
    }
    deps.stderr(serialized({
      ok: false,
      environment,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details === undefined
          ? {}
          : { details: showPii ? normalized.details : redactPii(normalized.details) }),
      },
    }, compact));
    return normalized.exitCode;
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
