// Custom Worker entry. Wraps the OpenNext-generated handler to add a scheduled
// (cron) handler that expires abandoned checkout orders. The OpenNext build
// emits `./.open-next/worker.js` with a default `{ fetch }` AND three Durable
// Object classes; all three MUST be re-exported or the deployment breaks.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from './.open-next/worker.js';
import { captureWorkerAlert, serializeError } from './src/lib/worker-sentry';
import { stripeFromEnv } from './src/lib/stripe';
import { supabaseFromEnv } from './src/lib/supabase';
import { expireAbandonedOrders, claimExpiryLease, finalizeExpiry, type CancelOutcome } from './src/lib/expire-orders';
import { sweepStalePromoRedemptions } from './src/lib/promo-reconcile';
import { recoverBalanceOrders } from './src/server/recover-balance-orders';
import { sweepSendcloudShipments } from './src/server/sweep-sendcloud-shipments';
import { isProbePath } from './src/lib/probe-paths';
import { applyCatalogDegradation } from './src/lib/request-degradation';
import { runWithRequestDegradation } from './src/lib/request-degradation-scope';
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
    // Per-request scope so a render served from the cold-fail-closed ceramic
    // catalogue can be answered with 503 + Retry-After instead of a 404 or a
    // ceramic-less sitemap (src/lib/request-degradation.ts).
    return runWithRequestDegradation(async (degradation) =>
      applyCatalogDegradation(request, await handler.fetch(request, env, ctx), degradation),
    );
  },

  async scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    ctx.waitUntil(recoverBalanceOrders({ supabase: supabaseFromEnv(env), stripe: stripeFromEnv(env), env, ctx })
      .catch(async (error) => {
        await captureWorkerAlert(env, { message: 'balance_recovery_sweep_failed', level: 'error', extra: { error: serializeError(error) } });
      }));
    // waitUntil discards rejections silently, so catch + log here — otherwise a
    // Supabase/Stripe failure mid-sweep would vanish with no signal that the cron ran.
    ctx.waitUntil(
      sweepAbandoned(env).catch(async (err) => {
        // M-15: a dead sweep must alert, not just log — Cron Past Events shows the
        // invocation green regardless, so a silent throw here goes unnoticed.
        console.error(JSON.stringify({ event: 'abandoned_sweep_error', error: serializeError(err) }));
        await captureWorkerAlert(env, {
          message: 'abandoned_sweep_error',
          level: 'error',
          extra: { error: serializeError(err) },
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
        console.error(JSON.stringify({ event: 'promo_reconcile_sweep_error', error: serializeError(err) }));
        await captureWorkerAlert(env, {
          message: 'promo_reconcile_sweep_error',
          level: 'error',
          extra: { error: serializeError(err) },
        });
      }),
    );
    // Sendcloud backstop: poll open parcels (webhook retries stop after ~1.5 h)
    // and send any pending studio label / customer shipping email.
    ctx.waitUntil(
      sweepSendcloud(env).catch(async (err) => {
        console.error(JSON.stringify({ event: 'sendcloud_sweep_error', error: serializeError(err) }));
        await captureWorkerAlert(env, {
          message: 'sendcloud_sweep_error',
          level: 'error',
          extra: { error: serializeError(err) },
        });
      }),
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;

/** Cron sweep: Sendcloud parcel status backstop (src/server/sweep-sendcloud-shipments.ts). */
async function sweepSendcloud(env: CloudflareEnv): Promise<void> {
  const result = await sweepSendcloudShipments({ supabase: supabaseFromEnv(env), env });
  if (result.failed.length > 0) {
    // Per-row failures don't throw (the sweep keeps converging the rest).
    await captureWorkerAlert(env, {
      message: 'sendcloud_sweep_row_errors: one or more Sendcloud parcels failed to update',
      level: 'error',
      extra: { failed: result.failed },
    });
  }
  console.log(JSON.stringify({ event: 'sendcloud_sweep_done', checked: result.checked, applied: result.applied, failed: result.failed.length }));
}

/**
 * Cron sweep: converge stale pending promo redemptions (Phase 2 Task 2
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
  if (result.errors > 0) {
    // Per-row settle failures don't throw (the sweep must keep converging
    // other rows), so a redemption stuck failing every run would otherwise be
    // invisible outside worker logs.
    await captureWorkerAlert(env, {
      message: 'promo_reconcile_row_errors: one or more promo redemption settles failed this sweep',
      level: 'warning',
      extra: { errors: result.errors, scanned: result.scanned },
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
        .is('gift_card_id', null)
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

// Re-export the OpenNext Durable Object classes so the deployment keeps working.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { CmsApi } from './src/server/cms-api/entrypoint';
