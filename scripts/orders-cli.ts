#!/usr/bin/env node
/**
 * npm run orders — order/inventory inspection + the four admin mutations
 * (refund, release-reservation, resend-confirmation, create-shipment),
 * outside the Cloudflare-Access-gated /admin UI. Follows the same shape as
 * scripts/prodigi-cli.ts: node:util.parseArgs, a <resource> <action> [id]
 * router, dependency injection for tests, a JSON envelope on stdout/stderr,
 * graded exit codes, and PII redaction on by default.
 *
 * Reads use whatever Supabase project the loaded env points at. Mutations
 * additionally require --confirm <order-id> (must exactly match the target)
 * and are blocked unless the loaded SUPABASE_URL matches the expected
 * production project ref — pass --allow-nonprod to target a different
 * project on purpose. See docs/orders-cli.md.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import {
  getOrder,
  listOrders,
  listInventory,
  isUuid,
  ORDER_STATUSES,
  type OrderStatus,
  type PieceStatus,
} from '../src/lib/admin/data';
import { adminSupabaseFromEnv, adminStripeFromEnv } from '../src/lib/admin/clients';
import { inpostFromEnv, type InPostClient } from '../src/lib/inpost';
import {
  refundOrder,
  releaseReservation,
  resendOrderConfirmation,
  createShipmentForOrder,
  type ActionResult,
} from '../src/lib/admin/actions';

/** Mirrors scripts/reconcile-orders.mjs's EXPECTED_SUPABASE_REF — the one production project. */
const EXPECTED_SUPABASE_REF = 'wnlysejenowymjdxlnaq';
const PIECE_STATUSES: readonly PieceStatus[] = ['available', 'reserved', 'sold'];

export interface CliDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  readTextFile(path: string): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  supabaseFactory(url: string, key: string): SupabaseClient;
  stripeFactory(key: string): Stripe;
  inpostFactory(env: CloudflareEnv): InPostClient;
}

const defaultDependencies: CliDependencies = {
  cwd: process.cwd(),
  env: process.env,
  readTextFile: (path) => readFile(path, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  supabaseFactory: adminSupabaseFromEnv,
  stripeFactory: adminStripeFromEnv,
  inpostFactory: inpostFromEnv,
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

const USAGE = `npm run orders -- [--env-file PATH] [--show-pii] [--compact] [--allow-nonprod] <resource> <action>

order get <uuid>
order list [--status STATUS] [--email EMAIL] [--top N]
inventory list [--status STATUS]
order refund <uuid> --confirm <uuid>
order release-reservation <uuid> --confirm <uuid>
order resend-confirmation <uuid> --confirm <uuid>
order create-shipment <uuid> [--recreate] --confirm <uuid>`;

type ParsedOptions = {
  'env-file'?: string;
  'show-pii'?: boolean;
  compact?: boolean;
  'allow-nonprod'?: boolean;
  status?: string;
  email?: string;
  top?: string;
  confirm?: string;
  recreate?: boolean;
  help?: boolean;
};

export function parseCliArgs(argv: string[]): { options: ParsedOptions; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'env-file': { type: 'string' },
        'show-pii': { type: 'boolean' },
        compact: { type: 'boolean' },
        'allow-nonprod': { type: 'boolean' },
        status: { type: 'string' },
        email: { type: 'string' },
        top: { type: 'string' },
        confirm: { type: 'string' },
        recreate: { type: 'boolean' },
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

/** Same precedence as scripts/prodigi-cli.ts: .env.local → .dev.vars → --env-file → process.env. */
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

function resolveSupabaseCreds(env: Record<string, string | undefined>): { url: string; key: string } {
  const url = env.ADMIN_SUPABASE_URL || env.SUPABASE_URL;
  const key = env.ADMIN_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new CliError(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or ADMIN_SUPABASE_* overrides)',
      3,
      'missing_config',
    );
  }
  return { url, key };
}

function resolveStripeKey(env: Record<string, string | undefined>): string {
  const key = env.ADMIN_STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY;
  if (!key) throw new CliError('Missing STRIPE_SECRET_KEY (or ADMIN_STRIPE_SECRET_KEY override)', 3, 'missing_config');
  return key;
}

function supabaseRefOf(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return '(unknown)';
  }
}

/** Blocks mutations against anything but the expected production project, unless overridden. */
function assertProdTarget(supabaseUrl: string, allowNonprod: boolean): void {
  const ref = supabaseRefOf(supabaseUrl);
  if (ref !== EXPECTED_SUPABASE_REF && !allowNonprod) {
    throw new CliError(
      `Supabase target '${ref}' is not the expected production project '${EXPECTED_SUPABASE_REF}'. ` +
        'Pass --allow-nonprod to run this mutation against a different project on purpose.',
      3,
      'nonprod_target_blocked',
    );
  }
}

function requireConfirmation(orderId: string, confirm: string | undefined): void {
  if (confirm !== orderId) {
    throw new CliError(`Mutation requires --confirm ${orderId}`, 3, 'confirmation_required');
  }
}

function requireOrderId(positionals: string[], usage: string): string {
  const id = positionals[2];
  if (positionals.length !== 3 || !isUuid(id)) {
    throw new CliError(`Expected ${usage}`, 2, 'invalid_arguments');
  }
  return id;
}

/** Unwraps an ActionResult: success returns its body, failure throws (mapped to exit 4/5). */
function unwrapAction(result: ActionResult): unknown {
  if (result.status >= 200 && result.status < 300) return result.body;
  const exitCode: 4 | 5 = result.status >= 500 ? 5 : 4;
  const message = 'error' in result.body ? result.body.error : 'Action failed';
  throw new CliError(message, exitCode, 'action_failed', { status: result.status, body: result.body });
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive integer`, 2, 'invalid_arguments');
  }
  return parsed;
}

function orderStatusOption(value: string | undefined): OrderStatus | undefined {
  if (value === undefined) return undefined;
  if (!ORDER_STATUSES.includes(value as OrderStatus)) {
    throw new CliError(`--status must be one of: ${ORDER_STATUSES.join(', ')}`, 2, 'invalid_arguments');
  }
  return value as OrderStatus;
}

function pieceStatusOption(value: string | undefined): PieceStatus | undefined {
  if (value === undefined) return undefined;
  if (!PIECE_STATUSES.includes(value as PieceStatus)) {
    throw new CliError(`--status must be one of: ${PIECE_STATUSES.join(', ')}`, 2, 'invalid_arguments');
  }
  return value as PieceStatus;
}

// ── PII redaction ─────────────────────────────────────────────────────────────

const PII_KEYS = new Set([
  'email',
  'name',
  'first_name',
  'last_name',
  'receiver_first_name',
  'receiver_last_name',
  'phone',
  'receiver_phone',
  'address',
  'shipping_address',
]);

export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPii);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = PII_KEYS.has(key) && child !== null ? '[REDACTED]' : redactPii(child);
  }
  return output;
}

// ── order get: Stripe PaymentIntent summary ──────────────────────────────────

type PaymentSummary =
  | { ok: true; status: string; cardBrand: string | null; cardLast4: string | null; refundedMinor: number }
  | { ok: false; reason: 'no_pi' | 'stripe_error' };

/** Mirrors src/app/admin/orders/[id]/page.tsx's loadPayment(). */
async function loadPayment(stripe: Stripe, paymentIntentId: string | null): Promise<PaymentSummary> {
  if (!paymentIntentId) return { ok: false, reason: 'no_pi' };
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = (pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null) as
      | { payment_method_details?: { card?: { brand?: string; last4?: string } }; amount_refunded?: number }
      | null;
    const card = charge?.payment_method_details?.card;
    return {
      ok: true,
      status: pi.status,
      cardBrand: card?.brand ?? null,
      cardLast4: card?.last4 ?? null,
      refundedMinor: charge?.amount_refunded ?? 0,
    };
  } catch {
    return { ok: false, reason: 'stripe_error' };
  }
}

async function orderGet(supabase: SupabaseClient, stripe: Stripe, id: string): Promise<unknown> {
  const order = await getOrder(id, { supabase });
  if (!order) throw new CliError(`Order not found: ${id}`, 4, 'not_found');

  const ceramicIds = order.items.filter((it) => it.variant == null).map((it) => it.product_id);
  const hasPrintItems = order.items.some((it) => it.variant != null);

  const [piecesRes, prodigiRes, jobsRes, payment] = await Promise.all([
    ceramicIds.length > 0
      ? supabase.from('piece_state').select('product_id, status, reserved_until, order_id').in('product_id', ceramicIds)
      : Promise.resolve({ data: [], error: null }),
    hasPrintItems
      ? supabase
          .from('prodigi_orders')
          .select('prodigi_order_id, prodigi_status_stage, cancel_alerted_at, shipping_email_sent_at, created_at, updated_at')
          .eq('order_id', id)
      : Promise.resolve({ data: [], error: null }),
    hasPrintItems
      ? supabase.from('fulfilment_jobs').select('status, attempts, last_error, created_at, updated_at').eq('order_id', id)
      : Promise.resolve({ data: [], error: null }),
    loadPayment(stripe, order.payment_intent_id),
  ]);
  if (piecesRes.error) throw new CliError(piecesRes.error.message, 4, 'action_failed');
  if (prodigiRes.error) throw new CliError(prodigiRes.error.message, 4, 'action_failed');
  if (jobsRes.error) throw new CliError(jobsRes.error.message, 4, 'action_failed');

  return {
    order,
    pieces: piecesRes.data ?? [],
    prodigiOrders: prodigiRes.data ?? [],
    fulfilmentJobs: jobsRes.data ?? [],
    payment,
  };
}

// ── command router ────────────────────────────────────────────────────────────

async function execute(
  positionals: string[],
  options: ParsedOptions,
  env: Record<string, string | undefined>,
  deps: CliDependencies,
): Promise<unknown> {
  const [resource, action] = positionals;

  if (resource === 'order' && action === 'get') {
    const id = requireOrderId(positionals, 'order get <uuid>');
    const { url, key } = resolveSupabaseCreds(env);
    const supabase = deps.supabaseFactory(url, key);
    const stripe = deps.stripeFactory(resolveStripeKey(env));
    return orderGet(supabase, stripe, id);
  }

  if (resource === 'order' && action === 'list') {
    if (positionals.length !== 2) throw new CliError('Expected order list', 2, 'invalid_arguments');
    const { url, key } = resolveSupabaseCreds(env);
    const supabase = deps.supabaseFactory(url, key);
    const status = orderStatusOption(options.status);
    const orders = await listOrders({ status, email: options.email }, { withItems: false, supabase });
    const top = positiveInteger(options.top, '--top');
    return top ? orders.slice(0, top) : orders;
  }

  if (resource === 'inventory' && action === 'list') {
    if (positionals.length !== 2) throw new CliError('Expected inventory list', 2, 'invalid_arguments');
    const { url, key } = resolveSupabaseCreds(env);
    const supabase = deps.supabaseFactory(url, key);
    const status = pieceStatusOption(options.status);
    const pieces = await listInventory({ supabase });
    return status ? pieces.filter((p) => p.status === status) : pieces;
  }

  if (resource === 'order' && action === 'refund') {
    const id = requireOrderId(positionals, 'order refund <uuid> --confirm <uuid>');
    requireConfirmation(id, options.confirm);
    const { url, key } = resolveSupabaseCreds(env);
    assertProdTarget(url, options['allow-nonprod'] ?? false);
    const supabase = deps.supabaseFactory(url, key);
    const stripe = deps.stripeFactory(resolveStripeKey(env));
    const cliEnv = env as unknown as CloudflareEnv;
    return unwrapAction(await refundOrder({ supabase, stripe, env: cliEnv }, id));
  }

  if (resource === 'order' && action === 'release-reservation') {
    const id = requireOrderId(positionals, 'order release-reservation <uuid> --confirm <uuid>');
    requireConfirmation(id, options.confirm);
    const { url, key } = resolveSupabaseCreds(env);
    assertProdTarget(url, options['allow-nonprod'] ?? false);
    const supabase = deps.supabaseFactory(url, key);
    const stripe = deps.stripeFactory(resolveStripeKey(env));
    return unwrapAction(await releaseReservation({ supabase, stripe }, id));
  }

  if (resource === 'order' && action === 'resend-confirmation') {
    const id = requireOrderId(positionals, 'order resend-confirmation <uuid> --confirm <uuid>');
    requireConfirmation(id, options.confirm);
    const { url, key } = resolveSupabaseCreds(env);
    assertProdTarget(url, options['allow-nonprod'] ?? false);
    const supabase = deps.supabaseFactory(url, key);
    const cliEnv = env as unknown as CloudflareEnv;
    return unwrapAction(await resendOrderConfirmation({ supabase, env: cliEnv }, id));
  }

  if (resource === 'order' && action === 'create-shipment') {
    const id = requireOrderId(positionals, 'order create-shipment <uuid> [--recreate] --confirm <uuid>');
    requireConfirmation(id, options.confirm);
    const { url, key } = resolveSupabaseCreds(env);
    assertProdTarget(url, options['allow-nonprod'] ?? false);
    const supabase = deps.supabaseFactory(url, key);
    const cliEnv = env as unknown as CloudflareEnv;
    const inpost = deps.inpostFactory(cliEnv);
    return unwrapAction(await createShipmentForOrder({ supabase, inpost }, id, { recreate: options.recreate === true }));
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
  try {
    const { options, positionals } = parseCliArgs(argv);
    compact = options.compact ?? false;
    showPii = options['show-pii'] ?? false;
    if (options.help || positionals.length === 0) {
      deps.stdout(serialized({ ok: true, data: { usage: USAGE } }, compact));
      return 0;
    }
    const env = await loadCliEnv(options['env-file'], deps);
    const result = await execute(positionals, options, env, deps);
    const data = showPii ? result : redactPii(result);
    deps.stdout(serialized({ ok: true, data }, compact));
    return 0;
  } catch (error) {
    let normalized: CliError;
    if (error instanceof CliError) normalized = error;
    else normalized = new CliError(error instanceof Error ? error.message : String(error), 1, 'internal_error');
    deps.stderr(serialized({
      ok: false,
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
