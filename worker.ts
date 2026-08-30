// Custom Worker entry. Wraps the OpenNext-generated handler to add a scheduled
// (cron) handler that expires abandoned checkout orders. The OpenNext build
// emits `./.open-next/worker.js` with a default `{ fetch }` AND three Durable
// Object classes; all three MUST be re-exported or the deployment breaks.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from './.open-next/worker.js';
import { captureWorkerAlert, type WorkerAlertLevel } from './src/lib/worker-sentry';
import { processJob } from './src/server/fulfilment/process-job';
import { decideMessageDisposition } from './src/server/fulfilment/queue-disposition';
import { buildDlqAlert, buildDlqBatchAlertEmail, isDlqQueue } from './src/server/fulfilment/dlq';
import {
  buildFailedActionAlert,
  type FailedActionJobInput,
} from './src/server/fulfilment/failed-action-alert';
import {
  buildStrandedJobAlert,
  STRANDED_STATUSES,
  type StrandedJobInput,
} from './src/server/fulfilment/stranded-job-alert';
import { sweepStaleProdigiOrders } from './src/server/fulfilment/reconcile-orders';
import type { FulfilmentJobMessage } from './src/server/prodigi/types';
import { stripeFromEnv } from './src/lib/stripe';
import { supabaseFromEnv } from './src/lib/supabase';
import { expireAbandonedOrders, claimExpiryLease, finalizeExpiry, type CancelOutcome } from './src/lib/expire-orders';
import { sweepStalePromoRedemptions } from './src/lib/promo-reconcile';
import { isProbePath } from './src/lib/probe-paths';
import { isAdminPath, verifyAdminAccess } from './src/lib/admin/access';
import { EMAIL, EMAIL_FROM } from './src/lib/email-addresses';
// Shared with the queue consumer (process-job outcome alerts) — throws on
// failure so cron sweeps only mark their `*_alerted_at` after a real send.
import { sendStudioAlertEmail } from './src/lib/studio-alert-email';

const ABANDON_AFTER_MS = 60 * 60 * 1000; // 1h — well past the 15-min reservation TTL; long enough not to cancel a slow-but-active buyer
const STRANDED_AFTER_MS = 2 * 60 * 60 * 1000; // 2h — a normal job leaves the pre-submission states in seconds; >2h means stuck
const BATCH_LIMIT = 100;

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isProbePath(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    if (isAdminPath(url.pathname)) {
      const result = await verifyAdminAccess(request, env);
      if (!result.ok) {
        return new Response('Not found', { status: result.status });
      }
      // Always strip a client-supplied actor header, then set it only from the
      // verified result. Without the strip, a forged X-Admin-Actor-Email survives
      // when result.email is absent (local bypass, or a JWT with no email claim)
      // and is then trusted for audit attribution.
      const headers = new Headers(request.headers);
      headers.delete('X-Admin-Actor-Email');
      if (result.email) headers.set('X-Admin-Actor-Email', result.email);
      request = new Request(request, { headers });
    }
    return handler.fetch(request, env, ctx);
  },

  async queue(
    batch: MessageBatch<FulfilmentJobMessage>,
    env: CloudflareEnv,
    ctx: ExecutionContext,
  ) {
    // Route on the queue name. The DLQ consumer is alert-only: it logs + fires
    // Sentry + emails the studio, then acks every message — it NEVER retries,
    // so a poison message cannot loop back through the system.
    if (isDlqQueue(batch.queue)) {
      await handleDlqBatch(batch, env, ctx);
      return;
    }
    for (const msg of batch.messages) {
      await processJob(msg.body, env, ctx)
        .then(() => msg.ack())
        .catch((err) => {
          const disposition = decideMessageDisposition(err);
          // L-21: log every queue error before ack/retry — otherwise a terminal
          // ack drops the message with no trace, and retries burn silently.
          // Redacted: log a stable error class + code only, never the raw message
          // (external-service errors can echo customer/request data). Full
          // per-item detail is persisted to fulfilment_jobs.last_error by
          // processJob; this handler log is a coarse retry/ack signal.
          const e = err as { name?: string; code?: string | number; status?: string | number };
          console.error(
            JSON.stringify({
              event: 'fulfilment_queue_error',
              orderId: msg.body?.orderId,
              attempt: msg.attempts,
              disposition,
              errorName: err instanceof Error ? err.name : typeof err,
              ...(e?.code !== undefined ? { errorCode: e.code } : {}),
              ...(e?.status !== undefined ? { errorStatus: e.status } : {}),
            }),
          );
          if (disposition === 'ack') msg.ack();
          // M-23: exponential backoff (60s, 120s, 240s … capped at 1h) so a brief
          // vendor blip doesn't burn all retries into the DLQ in seconds.
          else msg.retry({ delaySeconds: Math.min(2 ** msg.attempts * 30, 3600) });
        });
    }
  },

  async scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    // waitUntil discards rejections silently, so catch + log here — otherwise a
    // Supabase/Stripe failure mid-sweep would vanish with no signal that the cron ran.
    ctx.waitUntil(
      sweepAbandoned(env).catch(async (err) => {
        // M-15: a dead sweep must alert, not just log — Cron Past Events shows the
        // invocation green regardless, so a silent throw here goes unnoticed.
        console.error(JSON.stringify({ event: 'abandoned_sweep_error', error: String(err) }));
        await captureWorkerAlert(env, {
          message: 'abandoned_sweep_error',
          level: 'error',
          extra: { error: String(err) },
        });
      }),
    );
    // Alert sweep for failed_action_required fulfilment jobs. Idempotent: rows
    // are only marked alerted_at after the studio email sends, so a re-run with
    // no new failed jobs (or a transient email failure) sends/marks nothing.
    ctx.waitUntil(
      sweepFailedActionJobs(env).catch(async (err) => {
        console.error(JSON.stringify({ event: 'failed_action_sweep_error', error: String(err) }));
        await captureWorkerAlert(env, {
          message: 'failed_action_sweep_error',
          level: 'error',
          extra: { error: String(err) },
        });
      }),
    );
    // M-10: watchdog for jobs stranded in a pre-submission non-terminal state
    // (queued / fulfilment_submitting / failed_retryable) for >2h — the symptom
    // the failed_action_required sweep does not cover (e.g. a queue that never
    // delivered the message). Idempotent via its own `stranded_alerted_at`.
    ctx.waitUntil(
      sweepStrandedJobs(env).catch(async (err) => {
        console.error(JSON.stringify({ event: 'stranded_sweep_error', error: String(err) }));
        await captureWorkerAlert(env, {
          message: 'stranded_sweep_error',
          level: 'error',
          extra: { error: String(err) },
        });
      }),
    );
    // M-12: reconciliation for POST-submission orders whose callbacks were lost
    // — re-polls stale non-terminal prodigi_orders and re-runs the callback
    // merge, alerting when an order stops progressing. Complements M-10 (which
    // deliberately ignores fulfilment_submitted/in_production).
    ctx.waitUntil(
      sweepStaleProdigiOrders(env).catch(async (err) => {
        console.error(JSON.stringify({ event: 'prodigi_reconcile_sweep_error', error: String(err) }));
        await captureWorkerAlert(env, {
          message: 'prodigi_reconcile_sweep_error',
          level: 'error',
          extra: { error: String(err) },
        });
      }),
    );
    // Promo reconcile: converge stale `pending` promo_redemptions of terminal
    // orders (every webhook 'released' settle is best-effort, so a transient
    // failure would otherwise permanently over-count max_redemptions). A paid
    // order found with a pending redemption is markPaid's miss — settle it
    // redeemed AND alert.
    ctx.waitUntil(
      sweepPromoRedemptions(env).catch(async (err) => {
        console.error(JSON.stringify({ event: 'promo_reconcile_sweep_error', error: String(err) }));
        await captureWorkerAlert(env, {
          message: 'promo_reconcile_sweep_error',
          level: 'error',
          extra: { error: String(err) },
        });
      }),
    );
  },
} satisfies ExportedHandler<CloudflareEnv, FulfilmentJobMessage>;

/**
 * Alert-only consumer for `prodigi-fulfilment-dlq`. For each message: build the
 * alert (pure), log it, fire Sentry, collect the email fragment, and ACK —
 * never retry. One studio email is sent per batch (best-effort via
 * `ctx.waitUntil`); a Sentry/Resend outage is caught + logged so it cannot
 * crash the consumer or requeue a poison message. Acks happen inline (before
 * the email) so the no-loop guarantee holds even if the email send fails.
 */
async function handleDlqBatch(
  batch: MessageBatch<FulfilmentJobMessage>,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const sections: string[] = [];
  for (const msg of batch.messages) {
    const alert = buildDlqAlert({ id: msg.id, body: msg.body, attempts: msg.attempts });
    console.error(JSON.stringify(alert.log));
    // M-16: worker-context Sentry via a direct envelope POST (fail-soft; never
    // blocks the ack). @sentry/nextjs's captureMessage no-ops here (no init in
    // the worker bundle outside the fetch path).
    await captureWorkerAlert(env, {
      message: alert.sentry.message,
      level: alert.sentry.level as WorkerAlertLevel,
      extra: alert.sentry.extra,
    });
    sections.push(alert.emailSection);
    msg.ack(); // alert-only — ack every message, never retry/requeue
  }

  if (sections.length === 0) return;
  ctx.waitUntil(
    (async () => {
      try {
        await sendDlqAlertEmail(env, sections);
      } catch (emailErr) {
        console.error(
          JSON.stringify({ event: 'prodigi_dlq_email_failed', error: String(emailErr) }),
        );
      }
    })(),
  );
}

/**
 * Send one studio email summarising a DLQ batch via Resend. Uses `env` directly
 * (the queue handler has no request context, so the `getCloudflareContext()`-
 * based senders in src/lib/email.ts don't apply). Best-effort: the caller
 * catches so a Resend failure never requeues a message.
 */
async function sendDlqAlertEmail(env: CloudflareEnv, sections: string[]): Promise<void> {
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    console.warn(
      JSON.stringify({
        event: 'prodigi_dlq_email_skipped',
        reason: 'RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing',
      }),
    );
    return;
  }
  const { subject, html } = buildDlqBatchAlertEmail(sections);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [env.STUDIO_NOTIFY_EMAIL],
        reply_to: EMAIL.contact,
        subject,
        html,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fifth cron sweep: converge stale pending promo redemptions (Phase 2 Task 2
 * Step 4). The sweep logic lives in src/lib/promo-reconcile.ts; this wrapper
 * supplies the client and turns a paid-order reconcile (markPaid's miss) into
 * a Sentry warning.
 */
async function sweepPromoRedemptions(env: CloudflareEnv): Promise<void> {
  const supabase = supabaseFromEnv(env);
  const result = await sweepStalePromoRedemptions(supabase);
  for (const orderId of result.paidReconciledOrderIds) {
    await captureWorkerAlert(env, {
      message: 'promo_reconcile_paid_pending: a paid order still had a pending promo redemption (markPaid should have settled it)',
      level: 'warning',
      extra: { orderId },
    });
  }
  console.log(JSON.stringify({ event: 'promo_reconcile_sweep_done', ...result }));
}

async function sweepAbandoned(env: CloudflareEnv): Promise<void> {
  const stripe = stripeFromEnv(env);
  const supabase = supabaseFromEnv(env);
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();

  const result = await expireAbandonedOrders({
    loadAbandoned: async () => {
      // private_sale_id routes the piece release (finalizeExpiry);
      // refund_pending_at drives the stale-marker alert on a denied claim;
      // promo_code lets finalizeExpiry release the promo redemption.
      const { data, error } = await supabase
        .from('orders')
        .select('id, payment_intent_id, private_sale_id, refund_pending_at, promo_code')
        .eq('status', 'pending')
        .lt('created_at', cutoff)
        .limit(BATCH_LIMIT);
      if (error) throw new Error(`loadAbandoned failed: ${error.message}`);
      return (data ?? []) as Array<{
        id: string;
        payment_intent_id: string;
        private_sale_id: string | null;
        refund_pending_at: string | null;
        promo_code: string | null;
      }>;
    },
    // M-5 guard: the recoverable lease runs BEFORE cancelIntent (the
    // irreversible mutation), so a refund-pending order — even one whose
    // marker landed after loadAbandoned read it — is never PI-canceled here.
    // On failure after the claim the order stays pending and the lease goes
    // stale, so the next 15-min tick reclaims and retries.
    claimExpiry: (orderId) => claimExpiryLease(supabase, orderId),
    cancelIntent: async (pi): Promise<CancelOutcome> => {
      try {
        await stripe.paymentIntents.cancel(pi);
        return 'canceled';
      } catch {
        // Cancel rejected — inspect the live status to decide if it is paid or just transient.
        try {
          const intent = await stripe.paymentIntents.retrieve(pi);
          if (intent.status === 'canceled') return 'canceled';
          if (intent.status === 'succeeded' || intent.status === 'processing' || intent.status === 'requires_capture') return 'paid';
          // Any other status (e.g. requires_payment_method/confirmation/action) only
          // reaches here if cancel threw unexpectedly — Stripe normally permits cancel
          // for those. Skip safely: we never expire on 'error', so no oversell risk.
          return 'error';
        } catch {
          return 'error';
        }
      }
    },
    // Pieces first, lease-fenced terminal CAS last (the plan's terminal-only-
    // after-side-effects contract) — a piece-release failure throws, the order
    // stays `pending`, the lease goes stale, and the next tick reclaims.
    expireOrder: (order, claimToken) => finalizeExpiry(supabase, order, claimToken),
    warn: (msg, meta) => console.warn(JSON.stringify({ event: 'abandoned_sweep_warn', msg, ...meta })),
    alertPaidOnPending: async (orderId) => {
      // M-15: durable at-most-once claim — only alert if we win the CAS on the
      // `paid_on_pending_alerted_at` column, so a persistently-stuck order can't
      // emit a duplicate alert every 15-min cron tick.
      const { data, error } = await supabase
        .from('orders')
        .update({ paid_on_pending_alerted_at: new Date().toISOString() })
        .eq('id', orderId)
        .is('paid_on_pending_alerted_at', null)
        .select('id');
      if (error) {
        console.error(JSON.stringify({ event: 'paid_on_pending_claim_failed', orderId, error: error.message }));
        return;
      }
      if (!data || data.length === 0) return; // already alerted for this order — no-op.
      await captureWorkerAlert(env, {
        message:
          'paid_on_pending_order: a paid/processing PaymentIntent was found on a still-pending order (likely a missed payment_intent.succeeded)',
        level: 'error',
        extra: { orderId },
      });
      // Best-effort studio email — never throw (must not break the sweep).
      await sendPaidOnPendingEmail(env, orderId).catch((e) =>
        console.error(JSON.stringify({ event: 'paid_on_pending_email_failed', orderId, error: String(e) })),
      );
    },
  });

  console.log(JSON.stringify({ event: 'abandoned_sweep_done', ...result }));
}

/**
 * Best-effort studio email for a paid-on-pending order (M-15). Skips silently
 * when Resend/notify config is absent (the Sentry alert still fired). Uses `env`
 * directly (no request context in the cron).
 */
async function sendPaidOnPendingEmail(env: CloudflareEnv, orderId: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    console.warn(JSON.stringify({ event: 'paid_on_pending_email_skipped', reason: 'RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing' }));
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [env.STUDIO_NOTIFY_EMAIL],
        reply_to: EMAIL.contact,
        subject: `⚠️ Paid PaymentIntent on a pending order (${orderId})`,
        html: `<p>The abandoned-checkout cron found a <strong>paid/processing</strong> PaymentIntent on order <code>${orderId}</code>, which is still <code>pending</code> — a likely <strong>missed <code>payment_intent.succeeded</code></strong> webhook.</p><p>Reconcile the order manually (e.g. <code>npm run reconcile:orders</code>) and check the Stripe webhook delivery log.</p>`,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cron sweep: alert the studio about `fulfilment_jobs` stuck in
 * `failed_action_required`. Idempotent via the `alerted_at` guard — rows are
 * marked alerted only AFTER the studio email sends, so a transient email
 * failure (or missing Resend config) retries on the next tick instead of
 * silently dropping the alert. Sentry is best-effort and never gates the mark.
 *
 * Deliberate trade-off (not a lease): a transient failure of the mark write
 * after a successful send — or two overlapping cron ticks — can send a
 * duplicate alert. Duplicates are harmless; the alternative (claim/mark before
 * send without a lease) would SILENTLY LOSE an alert on send-failure, which is
 * strictly worse for alerting. A full lease column is YAGNI for a sub-second
 * sweep on a 15-min single-worker cron.
 */
async function sweepFailedActionJobs(env: CloudflareEnv): Promise<void> {
  const supabase = supabaseFromEnv(env);

  const { data, error } = await supabase
    .from('fulfilment_jobs')
    .select('id, order_id, attempts, last_error, updated_at')
    .eq('status', 'failed_action_required')
    .is('alerted_at', null)
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`sweepFailedActionJobs query failed: ${error.message}`);

  // Raw DB rows are snake_case; map onto the builder's camelCase input.
  const rows = (data ?? []) as Array<{
    id: string;
    order_id: string;
    attempts: number;
    last_error: string | null;
    updated_at: string;
  }>;
  const inputs: FailedActionJobInput[] = rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    attempts: r.attempts,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  }));
  if (inputs.length === 0) return; // ponytail: nothing to alert — re-run sends nothing.

  const alert = buildFailedActionAlert(inputs);
  console.error(JSON.stringify(alert.log));

  // M-16: worker-context Sentry via a direct envelope POST (fail-soft; must not
  // block the email or the mark).
  await captureWorkerAlert(env, {
    message: alert.sentry.message,
    level: alert.sentry.level as WorkerAlertLevel,
    extra: alert.sentry.extra,
  });

  // Email THROWS on failure (missing config or Resend error) — we only mark
  // alerted_at after a successful send, so a failure retries next tick.
  await sendStudioAlertEmail(env, alert.email, 'failed_action_required jobs');

  // Mark alerted only after the email succeeded. The `.is('alerted_at', null)`
  // guard makes this idempotent: a concurrent/re-run sweep can't double-mark.
  const { error: markErr } = await supabase
    .from('fulfilment_jobs')
    .update({ alerted_at: new Date().toISOString() })
    .in('id', inputs.map((j) => j.id))
    .is('alerted_at', null);
  if (markErr) throw new Error(`sweepFailedActionJobs mark failed: ${markErr.message}`);

  console.log(JSON.stringify({ event: 'failed_action_alerted', count: inputs.length }));
}

/**
 * M-10: sweep for jobs stranded in a pre-submission non-terminal state
 * (queued / fulfilment_submitting / failed_retryable) older than 2h. Mirrors
 * sweepFailedActionJobs: query unalerted rows → log + Sentry (warning) + email →
 * mark `stranded_alerted_at` only AFTER the email succeeds (once-only guard).
 *
 * Predicate keys on `created_at`, not `updated_at`: a `failed_retryable` job's
 * `updated_at` is bumped on every retry, so an updated_at threshold could miss a
 * job that has been failing for hours. `created_at < now()-2h` on these states
 * means "existed >2h and still never reached submitted/terminal" = stuck.
 */
async function sweepStrandedJobs(env: CloudflareEnv): Promise<void> {
  const supabase = supabaseFromEnv(env);
  const cutoff = new Date(Date.now() - STRANDED_AFTER_MS).toISOString();

  const { data, error } = await supabase
    .from('fulfilment_jobs')
    .select('id, order_id, status, attempts, created_at')
    .in('status', STRANDED_STATUSES as unknown as string[])
    .lt('created_at', cutoff)
    .is('stranded_alerted_at', null)
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`sweepStrandedJobs query failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: string;
    order_id: string;
    status: string;
    attempts: number;
    created_at: string;
  }>;
  const inputs: StrandedJobInput[] = rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    status: r.status,
    attempts: r.attempts,
    createdAt: r.created_at,
  }));
  if (inputs.length === 0) return; // nothing stranded — re-run alerts nothing.

  const alert = buildStrandedJobAlert(inputs);
  console.error(JSON.stringify(alert.log));
  await captureWorkerAlert(env, {
    message: alert.sentry.message,
    level: alert.sentry.level,
    extra: alert.sentry.extra,
  });
  // Email THROWS on failure — we mark stranded_alerted_at only after it succeeds,
  // so a failure retries next tick (own column: never collides with alerted_at).
  await sendStudioAlertEmail(env, alert.email, 'stranded fulfilment jobs');

  const { error: markErr } = await supabase
    .from('fulfilment_jobs')
    .update({ stranded_alerted_at: new Date().toISOString() })
    .in('id', inputs.map((j) => j.id))
    .is('stranded_alerted_at', null);
  if (markErr) throw new Error(`sweepStrandedJobs mark failed: ${markErr.message}`);

  console.log(JSON.stringify({ event: 'fulfilment_job_stranded_alerted', count: inputs.length }));
}

// Re-export the OpenNext Durable Object classes so the deployment keeps working.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
