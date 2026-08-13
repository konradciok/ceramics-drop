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
import { HANDLED_STRIPE_EVENTS } from '../src/lib/webhook';
import { inpostFromEnv, type InPostClient } from '../src/lib/inpost';
import {
  refundOrder,
  releaseReservation,
  resendOrderConfirmation,
  createShipmentForOrder,
  type ActionResult,
} from '../src/lib/admin/actions';

import prodTarget from './prod-target.json';

/** Single source of truth for the production project ref — shared with scripts/reconcile-orders.mjs (see scripts/prod-target.json). */
const EXPECTED_SUPABASE_REF = prodTarget.EXPECTED_SUPABASE_REF;
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
order create-shipment <uuid> [--recreate] --confirm <uuid>
webhook-config-check
reconcile-refunds [--since ISO8601] [--confirm <uuid>] [--skip-relist]`;

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
  since?: string;
  'skip-relist'?: boolean;
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
        since: { type: 'string' },
        'skip-relist': { type: 'boolean' },
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

// ── webhook-config-check: enabled_events / API-version drift guard ────────────

/** Host of the production storefront — endpoints on other hosts are ignored. */
const PROD_WEBHOOK_HOST = 'anna-ciok.studio';

type WebhookEndpointReport = {
  id: string;
  url: string;
  apiVersion: string | null;
  /** Handled events the endpoint does NOT subscribe — each one is a silently dead code path (this is how C-1 happened). */
  missingRequired: string[];
  apiVersionMismatch: { endpoint: string | null; sdk: string } | null;
  /** Subscribed events the handler ignores (`default: return`) — harmless noise, surfaced as a warning. */
  subscribedButUnhandled: string[];
  ok: boolean;
};

/**
 * Opp-2 drift guard: assert every enabled prod endpoint subscribes a superset
 * of HANDLED_STRIPE_EVENTS and delivers on the SDK's pinned API version.
 * Read-only. Run after any Stripe Dashboard change and after every `stripe`
 * package bump (see docs/stripe-operations.md).
 */
async function webhookConfigCheck(stripe: Stripe): Promise<unknown> {
  const sdkVersion = String(stripe.getApiField('version'));
  const { data: endpoints } = await stripe.webhookEndpoints.list({ limit: 100 });
  const required: readonly string[] = HANDLED_STRIPE_EVENTS;

  const prodEndpoints = endpoints.filter((ep) => {
    if (ep.status !== 'enabled') return false;
    try {
      return new URL(ep.url).hostname === PROD_WEBHOOK_HOST;
    } catch {
      return false;
    }
  });
  if (prodEndpoints.length === 0) {
    throw new CliError(
      `No enabled webhook endpoint found for host ${PROD_WEBHOOK_HOST} — the storefront receives no Stripe events at all`,
      4,
      'webhook_config_drift',
    );
  }

  const reports: WebhookEndpointReport[] = prodEndpoints.map((ep) => {
    const enabled = new Set(ep.enabled_events);
    const wildcard = enabled.has('*');
    const missingRequired = wildcard ? [] : required.filter((e) => !enabled.has(e));
    const subscribedButUnhandled = wildcard ? [] : ep.enabled_events.filter((e) => !required.includes(e));
    const apiVersionMismatch =
      ep.api_version === sdkVersion ? null : { endpoint: ep.api_version, sdk: sdkVersion };
    return {
      id: ep.id,
      url: ep.url,
      apiVersion: ep.api_version,
      missingRequired,
      apiVersionMismatch,
      subscribedButUnhandled,
      ok: missingRequired.length === 0 && apiVersionMismatch === null,
    };
  });

  const failing = reports.filter((r) => !r.ok);
  if (failing.length > 0) {
    const summary = failing
      .map((r) => {
        const problems: string[] = [];
        if (r.missingRequired.length > 0) problems.push(`missing required events: ${r.missingRequired.join(', ')}`);
        if (r.apiVersionMismatch) {
          problems.push(
            `api_version '${r.apiVersionMismatch.endpoint ?? '(account default)'}' does not match SDK '${r.apiVersionMismatch.sdk}'`,
          );
        }
        return `${r.id}: ${problems.join('; ')}`;
      })
      .join(' | ');
    throw new CliError(`Webhook config drift — ${summary}`, 4, 'webhook_config_drift', {
      sdkApiVersion: sdkVersion,
      endpoints: reports,
    });
  }

  return { sdkApiVersion: sdkVersion, endpoints: reports };
}

// ── reconcile-refunds: full-refund convergence sweep (Opp-3) ─────────────────

/**
 * Earliest order in the ledger — bounds the Stripe refund sweep so the command
 * stays O(recent) forever. Override with --since.
 */
const LEDGER_EPOCH = '2026-06-01';

/** fulfilment_jobs statuses that still lead to (or already reached) a Prodigi submission — same set cancelPrintFulfilment kills. */
const ACTIVE_JOB_STATUSES = ['queued', 'fulfilment_submitting', 'fulfilment_submitted', 'failed_retryable'];

type OrderJoinRow = {
  id: string;
  status: string;
  payment_intent_id: string | null;
  private_sale_id: string | null;
  conversions_sent_at: string | null;
};

type ProdigiRow = {
  order_id: string;
  prodigi_order_id: string;
  prodigi_status_stage: string | null;
  cancel_alerted_at: string | null;
};

function extractRefundPi(refund: Stripe.Refund): string | null {
  if (typeof refund.payment_intent === 'string') return refund.payment_intent;
  if (refund.payment_intent && typeof refund.payment_intent === 'object') return refund.payment_intent.id;
  const charge = refund.charge;
  if (charge && typeof charge === 'object') {
    const pi = (charge as Stripe.Charge).payment_intent;
    return typeof pi === 'string' ? pi : pi?.id ?? null;
  }
  return null;
}

/** List succeeded refunds since `sinceIso` whose charge is FULLY refunded, grouped by payment intent. */
async function listFullyRefundedPayments(
  stripe: Stripe,
  sinceIso: string,
): Promise<Map<string, string[]>> {
  const sinceEpoch = Math.floor(Date.parse(sinceIso) / 1000);
  const byPi = new Map<string, string[]>();
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.refunds.list({
      limit: 100,
      created: { gte: sinceEpoch },
      expand: ['data.charge'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const refund of page.data) {
      if (refund.status !== 'succeeded') continue;
      const charge = refund.charge && typeof refund.charge === 'object' ? (refund.charge as Stripe.Charge) : null;
      // Only a FULLY refunded charge converges the order — partial refunds
      // (e.g. shipping only) must never relist a piece.
      if (!charge || charge.amount_refunded < charge.amount) continue;
      const pi = extractRefundPi(refund);
      if (!pi) continue;
      byPi.set(pi, [...(byPi.get(pi) ?? []), refund.id]);
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return byPi;
}

/**
 * Opp-3 dry-run: report every fully-refunded payment whose order is not FULLY
 * converged — status, piece relist, Prodigi cancel and GA4 reversal all
 * accounted for. An order drops off only when every detectable side effect is
 * done, so the report can never read empty while a refunded order still has an
 * active Prodigi job.
 */
async function reconcileRefundsDryRun(
  supabase: SupabaseClient,
  stripe: Stripe,
  sinceIso: string,
): Promise<unknown> {
  const byPi = await listFullyRefundedPayments(stripe, sinceIso);
  const piIds = [...byPi.keys()];
  if (piIds.length === 0) return { since: sinceIso, fullyRefundedPayments: 0, unreconciled: [] };

  const { data: orderRows, error: ordersErr } = await supabase
    .from('orders')
    .select('id, status, payment_intent_id, private_sale_id, conversions_sent_at')
    .in('payment_intent_id', piIds);
  if (ordersErr) throw new CliError(`orders lookup failed: ${ordersErr.message}`, 4, 'action_failed');
  const orders = (orderRows ?? []) as OrderJoinRow[];
  const orderIds = orders.map((o) => o.id);

  const [piecesRes, jobsRes, prodigiRes] = await Promise.all([
    orderIds.length > 0
      ? supabase.from('piece_state').select('order_id, product_id').in('order_id', orderIds).eq('status', 'sold')
      : Promise.resolve({ data: [], error: null }),
    orderIds.length > 0
      ? supabase.from('fulfilment_jobs').select('order_id, status').in('order_id', orderIds).in('status', ACTIVE_JOB_STATUSES)
      : Promise.resolve({ data: [], error: null }),
    orderIds.length > 0
      ? supabase
          .from('prodigi_orders')
          .select('order_id, prodigi_order_id, prodigi_status_stage, cancel_alerted_at')
          .in('order_id', orderIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const res of [piecesRes, jobsRes, prodigiRes]) {
    if (res.error) throw new CliError(`convergence lookup failed: ${res.error.message}`, 4, 'action_failed');
  }
  const soldPieces = (piecesRes.data ?? []) as Array<{ order_id: string; product_id: string }>;
  const activeJobs = (jobsRes.data ?? []) as Array<{ order_id: string; status: string }>;
  const prodigiRows = (prodigiRes.data ?? []) as ProdigiRow[];

  const ordersByPi = new Map(orders.map((o) => [o.payment_intent_id, o]));
  const unreconciled: unknown[] = [];
  let convergedCount = 0;

  for (const [pi, refundIds] of byPi) {
    const order = ordersByPi.get(pi);
    if (!order) {
      // A refund for a payment this shop has no order for — an orphaned PI or
      // an event from another environment; surface it rather than skip.
      unreconciled.push({ orderId: null, paymentIntentId: pi, refundIds, problems: ['no_order_for_payment_intent'] });
      continue;
    }

    const problems: string[] = [];
    const followUps: string[] = [];
    // `failed` is the markPaid under-fulfilment path: it issued its own refund
    // and freed the pieces before setting the order failed — releaseSale
    // deliberately no-ops there, so the CLI must treat it as converged too.
    if (order.status !== 'refunded' && order.status !== 'failed') problems.push('status_not_refunded');
    // Private-sale pieces stay `sold` on refund by design — never a problem.
    const stillSold = order.private_sale_id ? [] : soldPieces.filter((p) => p.order_id === order.id).map((p) => p.product_id);
    if (stillSold.length > 0) problems.push('pieces_still_sold');
    const jobs = activeJobs.filter((j) => j.order_id === order.id);
    const prodigi = prodigiRows.find(
      (p) => p.order_id === order.id && p.prodigi_status_stage !== 'Cancelled' && !p.cancel_alerted_at,
    );
    if (jobs.length > 0 || prodigi) problems.push('prodigi_active');
    // GA4 reversal only ever fires on releaseSale's real paid→refunded flip; if
    // the order never converged AND a purchase conversion was recorded, the
    // recorded revenue is still standing.
    if (problems.includes('status_not_refunded') && order.conversions_sent_at) followUps.push('ga4_refund_reversal');

    if (problems.length === 0) {
      convergedCount += 1;
      continue;
    }
    unreconciled.push({
      orderId: order.id,
      paymentIntentId: pi,
      refundIds,
      orderStatus: order.status,
      privateSale: order.private_sale_id !== null,
      problems,
      piecesStillSold: stillSold,
      ...(jobs.length > 0 || prodigi
        ? {
            prodigi: {
              activeJobs: jobs.length,
              ...(prodigi ? { prodigiOrderId: prodigi.prodigi_order_id, stage: prodigi.prodigi_status_stage } : {}),
            },
          }
        : {}),
      followUps,
    });
  }

  return {
    since: sinceIso,
    fullyRefundedPayments: byPi.size,
    converged: convergedCount,
    unreconciled,
  };
}

/**
 * Opp-3 repair: converge ONE order using the same CAS predicates as
 * releaseSale (order paid/pending→refunded, pieces relisted scoped to
 * order_id). Side effects the CLI cannot perform offline — Prodigi cancel
 * (needs the Workers env) and the GA4 revenue reversal (no marketing context
 * offline) — are emitted as an explicit REQUIRED FOLLOW-UP block and the order
 * is reported partially-converged, so the next dry-run still lists it. This is
 * a bounded repair with an explicit remainder, not a releaseSale replacement —
 * prefer replaying the `charge.refunded` event from Stripe Workbench when the
 * webhook is subscribed and healthy.
 */
async function reconcileRefundConfirm(
  supabase: SupabaseClient,
  stripe: Stripe,
  orderId: string,
  skipRelist: boolean,
): Promise<unknown> {
  const { data: orderRow, error: orderErr } = await supabase
    .from('orders')
    .select('id, status, payment_intent_id, private_sale_id, conversions_sent_at')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) throw new CliError(`order lookup failed: ${orderErr.message}`, 4, 'action_failed');
  const order = orderRow as OrderJoinRow | null;
  if (!order) throw new CliError(`Order not found: ${orderId}`, 4, 'not_found');
  if (!order.payment_intent_id) throw new CliError(`Order ${orderId} has no payment_intent_id`, 4, 'action_failed');
  if (order.status === 'failed' || order.status === 'expired') {
    // The under-fulfilment auto-refund (failed) already freed the pieces, and
    // an expired order was never paid — releaseSale no-ops for both by design.
    throw new CliError(
      `Order ${orderId} is '${order.status}' — nothing to reconcile (releaseSale deliberately no-ops here)`,
      4,
      'order_not_reconcilable',
    );
  }

  // Money-path guard: never converge an order to `refunded` unless Stripe
  // confirms the payment is FULLY refunded right now.
  const pi = await stripe.paymentIntents.retrieve(order.payment_intent_id, { expand: ['latest_charge'] });
  const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? (pi.latest_charge as Stripe.Charge) : null;
  if (!charge || charge.amount_refunded < charge.amount) {
    throw new CliError(
      `Payment ${order.payment_intent_id} is not fully refunded in Stripe (refunded ${charge?.amount_refunded ?? 0} of ${charge?.amount ?? '?'}) — refusing to converge`,
      4,
      'not_fully_refunded',
    );
  }

  // Order CAS — same predicate family as releaseSale (paid→refunded and the
  // pending→refunded park); an already-refunded order skips to the relist.
  let orderStatusCas: 'refunded' | 'already_refunded' = 'already_refunded';
  if (order.status !== 'refunded') {
    const { data: casRows, error: casErr } = await supabase
      .from('orders')
      .update({ status: 'refunded' })
      .eq('id', orderId)
      .in('status', ['paid', 'pending'])
      .select('id');
    if (casErr) throw new CliError(`order CAS failed: ${casErr.message}`, 4, 'action_failed');
    if (!casRows || casRows.length === 0) {
      throw new CliError(
        `Order ${orderId} changed status concurrently — re-run the dry-run and retry`,
        4,
        'action_failed',
      );
    }
    orderStatusCas = 'refunded';
  }

  // Piece release — releaseSale's convergence semantics: public orders relist
  // sold/reserved rows to `available`; private-sale orders converge only
  // stranded `reserved` rows to `sold` (never relisted publicly). Scoped to
  // order_id so pieces re-sold to another order are never touched.
  // --skip-relist (operator decision: the piece must NOT return to sale, e.g.
  // damaged-in-transit) converges pieces to the same TERMINAL state releaseSale
  // gives private-sale pieces — `sold` with the order link detached — so the
  // decision is recorded in piece_state itself and the dry-run stops flagging
  // the order (a piece left `sold` with order_id set is indistinguishable from
  // a crashed release and would re-surface forever).
  const offSale = skipRelist || order.private_sale_id !== null;
  const target = offSale ? 'sold' : 'available';
  const fromStatuses = order.private_sale_id && !skipRelist ? ['reserved'] : ['sold', 'reserved'];
  const { data: freed, error: relistErr } = await supabase
    .from('piece_state')
    .update({ status: target, reserved_until: null, order_id: null })
    .eq('order_id', orderId)
    .in('status', fromStatuses)
    .select('product_id');
  if (relistErr) throw new CliError(`piece_state release failed: ${relistErr.message}`, 4, 'action_failed');
  const relist = {
    outcome: skipRelist ? ('kept_off_sale' as const) : order.private_sale_id ? ('private_sale_converged' as const) : ('relisted' as const),
    pieces: ((freed ?? []) as Array<{ product_id: string }>).map((p) => p.product_id),
  };

  // Side effects the CLI cannot perform offline → explicit REQUIRED FOLLOW-UP.
  const requiredFollowUps: Array<{ kind: string; detail: string }> = [];
  const [jobsRes, prodigiRes] = await Promise.all([
    supabase.from('fulfilment_jobs').select('order_id, status').eq('order_id', orderId).in('status', ACTIVE_JOB_STATUSES),
    supabase
      .from('prodigi_orders')
      .select('order_id, prodigi_order_id, prodigi_status_stage, cancel_alerted_at')
      .eq('order_id', orderId),
  ]);
  const jobs = (jobsRes.data ?? []) as Array<{ order_id: string; status: string }>;
  const prodigi = ((prodigiRes.data ?? []) as ProdigiRow[]).find(
    (p) => p.prodigi_status_stage !== 'Cancelled' && !p.cancel_alerted_at,
  );
  if (jobs.length > 0 || prodigi) {
    requiredFollowUps.push({
      kind: 'prodigi_cancel',
      detail:
        `Prodigi fulfilment is still active for ${orderId}` +
        (prodigi ? ` (prodigi order ${prodigi.prodigi_order_id}, stage ${prodigi.prodigi_status_stage})` : ` (${jobs.length} active job(s))`) +
        '. Cancel via cancelPrintFulfilment in the Workers env: replay the charge.refunded event from Stripe Workbench, or cancel manually in the Prodigi dashboard. Do NOT mark this handled until the job/order is cancelled.',
    });
  }
  if (order.status === 'paid' && order.conversions_sent_at) {
    requiredFollowUps.push({
      kind: 'ga4_refund_reversal',
      detail:
        `A GA4 purchase was recorded for ${orderId} (conversions_sent_at set) and its revenue is NOT yet reversed. ` +
        'The offline CLI has no marketing context to send the refund event — send a GA4 `refund` event manually ' +
        '(see src/lib/marketing/ga4-mp.ts) or accept the standing revenue and note it.',
    });
  }

  return {
    orderId,
    paymentIntentId: order.payment_intent_id,
    previousStatus: order.status,
    orderStatusCas,
    relist,
    requiredFollowUps,
    // Partially-converged while any follow-up remains — subsequent dry-runs
    // keep listing this order until the Prodigi side is actually cancelled.
    converged: requiredFollowUps.length === 0,
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

  if (resource === 'webhook-config-check') {
    if (positionals.length !== 1) throw new CliError('Expected webhook-config-check', 2, 'invalid_arguments');
    const stripe = deps.stripeFactory(resolveStripeKey(env));
    return webhookConfigCheck(stripe);
  }

  if (resource === 'reconcile-refunds') {
    if (positionals.length !== 1) {
      throw new CliError('Expected reconcile-refunds [--since ISO8601] [--confirm <uuid>] [--skip-relist]', 2, 'invalid_arguments');
    }
    const sinceIso = options.since ?? LEDGER_EPOCH;
    if (Number.isNaN(Date.parse(sinceIso))) {
      throw new CliError(`--since must be an ISO-8601 date, got '${sinceIso}'`, 2, 'invalid_arguments');
    }
    const { url, key } = resolveSupabaseCreds(env);
    const stripe = deps.stripeFactory(resolveStripeKey(env));
    if (options.confirm === undefined) {
      const supabase = deps.supabaseFactory(url, key);
      return reconcileRefundsDryRun(supabase, stripe, sinceIso);
    }
    if (!isUuid(options.confirm)) {
      throw new CliError('--confirm must be the order uuid to converge', 2, 'invalid_arguments');
    }
    assertProdTarget(url, options['allow-nonprod'] ?? false);
    const supabase = deps.supabaseFactory(url, key);
    return reconcileRefundConfirm(supabase, stripe, options.confirm, options['skip-relist'] ?? false);
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
