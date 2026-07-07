import * as Sentry from '@sentry/nextjs';
import { getSupabaseAdmin } from '@/lib/supabase';
import { emailPrintRefundAlertToStudio } from '@/lib/email';
import { prodigiClient } from '../prodigi/client';

/**
 * Stop the Prodigi side of a print order after a full refund / lost dispute.
 *
 * - Ceramic order (no print line items) → no-op.
 * - Job queued but never submitted (no prodigi_orders row) → mark the job
 *   'cancelled' so processJob can't claim it. (processJob's own "order not
 *   paid" guard is the backstop once the webhook flips the status; this closes
 *   the admin-refund window where the order is still 'paid'.)
 * - Prodigi order cancellable → cancel it, record stage 'Cancelled'.
 * - Already in production/shipped (cancel unavailable or failed) → Sentry
 *   alert + studio email, claim-once via prodigi_orders.cancel_alerted_at.
 *
 * Best-effort relative to Stripe: never throws — a Prodigi/DB/email hiccup here
 * must not 5xx the refund webhook into an endless retry loop. Every failure
 * path lands in Sentry, so nothing no-ops silently.
 */
export async function cancelPrintFulfilment(orderId: string, env: CloudflareEnv): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    const { count, error: itemsErr } = await supabase
      .from('order_items')
      .select('*', { count: 'exact', head: true })
      .eq('order_id', orderId)
      .not('variant', 'is', null);
    if (itemsErr) throw new Error(`cancelPrintFulfilment: order_items count failed for ${orderId}: ${itemsErr.message}`);
    if (!count) return; // ceramic order — Prodigi was never involved

    const { data: po, error: poErr } = await supabase
      .from('prodigi_orders')
      .select('prodigi_order_id, prodigi_status_stage, cancel_alerted_at')
      .eq('order_id', orderId)
      .maybeSingle();
    if (poErr) throw new Error(`cancelPrintFulfilment: prodigi_orders lookup failed for ${orderId}: ${poErr.message}`);

    if (!po) {
      const { error: jobErr } = await supabase
        .from('fulfilment_jobs')
        .update({ status: 'cancelled', last_error: 'order refunded before submission', updated_at: now })
        .eq('order_id', orderId)
        .in('status', ['queued', 'failed_retryable']);
      if (jobErr) throw new Error(`cancelPrintFulfilment: job cancel failed for ${orderId}: ${jobErr.message}`);
      return;
    }

    // Stage uses raw Prodigi casing ('Cancelled') — same convention as
    // processJob ('InProgress') and the callback upsert.
    if (po.prodigi_status_stage === 'Cancelled' || po.cancel_alerted_at) return; // already handled

    const client = prodigiClient(env);
    let cancelled = false;
    const actions = await client.getOrderActions(po.prodigi_order_id);
    if (actions.cancel?.isAvailable === 'Yes') {
      const res = await client.cancelOrder(po.prodigi_order_id);
      cancelled = res.outcome === 'Cancelled';
    }

    if (cancelled) {
      const { error: upErr } = await supabase
        .from('prodigi_orders')
        .update({ prodigi_status_stage: 'Cancelled', updated_at: now })
        .eq('prodigi_order_id', po.prodigi_order_id);
      if (upErr) throw new Error(`cancelPrintFulfilment: stage update failed for ${orderId}: ${upErr.message}`);
      return;
    }

    // In production / shipped / cancel refused → a human must resolve it.
    // Claim before alerting so admin-refund + webhook can't double-alert.
    const { data: claimed, error: claimErr } = await supabase
      .from('prodigi_orders')
      .update({ cancel_alerted_at: now })
      .eq('prodigi_order_id', po.prodigi_order_id)
      .is('cancel_alerted_at', null)
      .select('order_id');
    if (claimErr) throw new Error(`cancelPrintFulfilment: alert claim failed for ${orderId}: ${claimErr.message}`);
    if (!claimed || claimed.length === 0) return; // another path already alerted

    Sentry.captureMessage('print_refund_manual_cancel_required', {
      level: 'warning',
      extra: { orderId, prodigiOrderId: po.prodigi_order_id, stage: po.prodigi_status_stage },
    });
    // ponytail: if the email fails the claim sticks — Sentry (message above +
    // exception below) already carries the same alert, so no release dance.
    await emailPrintRefundAlertToStudio({
      orderId,
      prodigiOrderId: po.prodigi_order_id,
      stage: po.prodigi_status_stage,
    });
  } catch (err) {
    console.error('cancelPrintFulfilment failed for', orderId, err);
    Sentry.captureException(err);
  }
}
