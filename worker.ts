// Custom Worker entry. Wraps the OpenNext-generated handler to add a scheduled
// (cron) handler that expires abandoned checkout orders. The OpenNext build
// emits `./.open-next/worker.js` with a default `{ fetch }` AND three Durable
// Object classes; all three MUST be re-exported or the deployment breaks.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from './.open-next/worker.js';
import { stripeFromEnv } from './src/lib/stripe';
import { supabaseFromEnv } from './src/lib/supabase';
import { expireAbandonedOrders, type CancelOutcome } from './src/lib/expire-orders';

const ABANDON_AFTER_MS = 60 * 60 * 1000; // 1h — well past the 15-min reservation TTL; long enough not to cancel a slow-but-active buyer
const BATCH_LIMIT = 100;

export default {
  fetch: handler.fetch,

  async scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    // waitUntil discards rejections silently, so catch + log here — otherwise a
    // Supabase/Stripe failure mid-sweep would vanish with no signal that the cron ran.
    ctx.waitUntil(
      sweepAbandoned(env).catch((err) =>
        console.error(JSON.stringify({ event: 'abandoned_sweep_error', error: String(err) })),
      ),
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;

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
        .select('id');
      if (error) throw new Error(`expireOrder update failed for ${orderId}: ${error.message}`);
      const rows = data as Array<{ id: string }> | null;
      if (!rows || rows.length === 0) return false;
      const { error: pieceErr } = await supabase
        .from('piece_state')
        .update({ status: 'available', reserved_until: null, order_id: null })
        .eq('order_id', orderId)
        .eq('status', 'reserved');
      if (pieceErr) throw new Error(`expireOrder piece release failed for ${orderId}: ${pieceErr.message}`);
      return true;
    },
    warn: (msg, meta) => console.warn(JSON.stringify({ event: 'abandoned_sweep_warn', msg, ...meta })),
  });

  console.log(JSON.stringify({ event: 'abandoned_sweep_done', ...result }));
}

// Re-export the OpenNext Durable Object classes so the deployment keeps working.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail post-build, when the import resolves
// @ts-ignore `.open-next/worker.js` is generated at build time
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
