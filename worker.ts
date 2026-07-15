// Custom Worker entry. Wraps the OpenNext-generated handler to add a scheduled
// (cron) handler that expires abandoned checkout orders. The OpenNext build
// emits `./.open-next/worker.js` with a default `{ fetch }` AND three Durable
// Object classes; all three MUST be re-exported or the deployment breaks.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from './.open-next/worker.js';
import * as Sentry from '@sentry/nextjs';
import { processJob } from './src/server/fulfilment/process-job';
import { decideMessageDisposition } from './src/server/fulfilment/queue-disposition';
import { buildDlqAlert, buildDlqBatchAlertEmail, DLQ_QUEUE_NAME } from './src/server/fulfilment/dlq';
import {
  buildFailedActionAlert,
  type FailedActionJobInput,
} from './src/server/fulfilment/failed-action-alert';
import type { FulfilmentJobMessage } from './src/server/prodigi/types';
import { stripeFromEnv } from './src/lib/stripe';
import { supabaseFromEnv } from './src/lib/supabase';
import { expireAbandonedOrders, type CancelOutcome } from './src/lib/expire-orders';
import { releaseTargetStatus } from './src/lib/piece-release';
import { isProbePath } from './src/lib/probe-paths';
import { isAdminPath, verifyAdminAccess } from './src/lib/admin/access';
import { EMAIL, EMAIL_FROM } from './src/lib/email-addresses';

const ABANDON_AFTER_MS = 60 * 60 * 1000; // 1h — well past the 15-min reservation TTL; long enough not to cancel a slow-but-active buyer
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
    if (batch.queue === DLQ_QUEUE_NAME) {
      await handleDlqBatch(batch, env, ctx);
      return;
    }
    for (const msg of batch.messages) {
      await processJob(msg.body, env, ctx)
        .then(() => msg.ack())
        .catch((err) => {
          if (decideMessageDisposition(err) === 'ack') msg.ack();
          else msg.retry();
        });
    }
  },

  async scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    // waitUntil discards rejections silently, so catch + log here — otherwise a
    // Supabase/Stripe failure mid-sweep would vanish with no signal that the cron ran.
    ctx.waitUntil(
      sweepAbandoned(env).catch((err) =>
        console.error(JSON.stringify({ event: 'abandoned_sweep_error', error: String(err) })),
      ),
    );
    // Alert sweep for failed_action_required fulfilment jobs. Idempotent: rows
    // are only marked alerted_at after the studio email sends, so a re-run with
    // no new failed jobs (or a transient email failure) sends/marks nothing.
    ctx.waitUntil(
      sweepFailedActionJobs(env).catch((err) =>
        console.error(JSON.stringify({ event: 'failed_action_sweep_error', error: String(err) })),
      ),
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
    try {
      Sentry.captureMessage(alert.sentry.message, {
        level: alert.sentry.level,
        extra: alert.sentry.extra,
      });
    } catch (sentryErr) {
      // ponytail: no rethrow — a Sentry init/outage must not block the ack.
      console.error(
        JSON.stringify({ event: 'prodigi_dlq_sentry_failed', messageId: msg.id, error: String(sentryErr) }),
      );
    }
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

async function sweepAbandoned(env: CloudflareEnv): Promise<void> {
  const stripe = stripeFromEnv(env);
  const supabase = supabaseFromEnv(env);
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();

  const result = await expireAbandonedOrders({
    loadAbandoned: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, payment_intent_id')
        .eq('status', 'pending')
        .lt('created_at', cutoff)
        .limit(BATCH_LIMIT);
      if (error) throw new Error(`loadAbandoned failed: ${error.message}`);
      return (data ?? []) as Array<{ id: string; payment_intent_id: string }>;
    },
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
    expireOrder: async (orderId) => {
      const { data, error } = await supabase
        .from('orders')
        .update({ status: 'expired' })
        .eq('id', orderId)
        .eq('status', 'pending')
        .select('id, private_sale_id');
      if (error) throw new Error(`expireOrder update failed for ${orderId}: ${error.message}`);
      const rows = data as Array<{ id: string; private_sale_id: string | null }> | null;
      if (!rows || rows.length === 0) return false;
      // Private-sale pieces return to `sold` (never relisted publicly); normal holds relist.
      const { error: pieceErr } = await supabase
        .from('piece_state')
        .update({ status: releaseTargetStatus(rows[0]), reserved_until: null, order_id: null })
        .eq('order_id', orderId)
        .eq('status', 'reserved');
      if (pieceErr) throw new Error(`expireOrder piece release failed for ${orderId}: ${pieceErr.message}`);
      return true;
    },
    warn: (msg, meta) => console.warn(JSON.stringify({ event: 'abandoned_sweep_warn', msg, ...meta })),
  });

  console.log(JSON.stringify({ event: 'abandoned_sweep_done', ...result }));
}

/**
 * Cron sweep: alert the studio about `fulfilment_jobs` stuck in
 * `failed_action_required`. Idempotent via the `alerted_at` guard — rows are
 * marked alerted only AFTER the studio email sends, so a transient email
 * failure (or missing Resend config) retries on the next tick instead of
 * silently dropping the alert. Sentry is best-effort and never gates the mark.
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

  // Sentry is best-effort: an init/outage must not block the email or the mark.
  try {
    Sentry.captureMessage(alert.sentry.message, {
      level: alert.sentry.level,
      extra: alert.sentry.extra,
    });
  } catch (sentryErr) {
    console.error(
      JSON.stringify({ event: 'failed_action_sentry_failed', error: String(sentryErr) }),
    );
  }

  // Email THROWS on failure (missing config or Resend error) — we only mark
  // alerted_at after a successful send, so a failure retries next tick.
  await sendFailedActionAlertEmail(env, alert.email);

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
 * Send the failed_action_required studio alert via Resend. Uses `env` directly
 * (the scheduled handler has no request context). THROWS on missing config or a
 * Resend failure — the caller only marks `alerted_at` once this resolves, so a
 * throw correctly leaves the rows unalerted for the next cron tick.
 */
async function sendFailedActionAlertEmail(
  env: CloudflareEnv,
  email: { subject: string; html: string },
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing — cannot alert failed_action_required jobs');
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
        subject: email.subject,
        html: email.html,
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

// Re-export the OpenNext Durable Object classes so the deployment keeps working.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
