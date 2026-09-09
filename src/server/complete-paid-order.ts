import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { enqueueProdigi } from './fulfilment/enqueue';
import { createInvoiceForOrder } from '@/lib/invoice';
import { createShipmentForOrder } from '@/lib/admin/actions';
import { inpostFromEnv } from '@/lib/inpost';
import { emailNewOrderToStudio, emailOrderConfirmationToCustomer, type NewOrderEmailOrder } from '@/lib/email';
import { issueBalanceGiftCard } from './issue-balance-gift-card';
import { sendPurchasedEvent } from '@/lib/resend-events';

export type PaidOrderDeps = { supabase: SupabaseClient; stripe: Stripe; env: CloudflareEnv; ctx: ExecutionContext };

/** Retryable paid-order work, addressed by order id. Works after Stripe or a
 * full balance payment. The paid row is the durable outbox; cron retries rows
 * without completed_at after an interrupted request or expired worker lease. */
export async function completePaidOrder(orderId: string, deps: PaidOrderDeps): Promise<boolean> {
  const { supabase, stripe, env, ctx } = deps;
  const claim = crypto.randomUUID();
  const now = new Date();
  const stale = new Date(now.getTime() - 5 * 60_000).toISOString();
  const { data: order, error } = await supabase.from('orders')
    .update({ paid_processing_claim: claim, paid_processing_started_at: now.toISOString() })
    .eq('id', orderId).eq('status', 'paid').is('paid_processing_completed_at', null)
    .or(`paid_processing_claim.is.null,paid_processing_started_at.lt.${stale}`)
    .select('*').maybeSingle();
  if (error) throw new Error(`Paid-order claim failed: ${error.message}`);
  if (!order) return false;
  try {
    const { data: items, error: itemsError } = await supabase.from('order_items')
      .select('product_id,unit_price,variant').eq('order_id', orderId);
    if (itemsError || !items?.length) throw new Error('Paid order items could not be loaded');
    if (!order.email) throw new Error('Paid order recipient missing');
    if (order.fulfilment_type === 'prodigi') {
      await enqueueProdigi(orderId, env, ctx, supabase);
    } else if (order.fulfilment_type === 'inpost') {
      const shipment = await createShipmentForOrder({ supabase, inpost: inpostFromEnv(env) }, orderId);
      if (shipment.status !== 200) throw new Error('Paid order shipment requires retry');
    }
    await createInvoiceForOrder({ orderId }, { supabase, stripe });
    await sendPurchasedEvent({ orderId, email: order.email, env });
    // Provider idempotency keys cover accepted-but-timed-out sends. Persist
    // each successful step separately so a later step's retry skips it.
    if (!order.confirmation_email_sent_at && order.email) {
      if (order.fulfilment_type === 'giftcard') {
        await issueBalanceGiftCard(order, items, supabase, env);
      } else {
      await emailOrderConfirmationToCustomer({
        order: { id: orderId, email: order.email, receiver_first_name: order.receiver_first_name,
          payment: { total: order.total, currency: order.currency, gift_card_amount: order.gift_card_amount, gift_card_balance_after: order.gift_card_balance_after } },
        locale: order.locale ?? 'pl', kind: order.fulfilment_type === 'prodigi' ? 'print' : 'ceramic', env,
        idempotencyKey: `order-confirmation/${orderId}`,
      });
      }
      const { error: sentError } = await supabase.from('orders').update({ confirmation_email_sent_at: new Date().toISOString() })
        .eq('id', orderId).eq('paid_processing_claim', claim);
      if (sentError) throw sentError;
    }
    if (!order.studio_email_sent_at) {
      await emailNewOrderToStudio({ order: { ...order, items } as NewOrderEmailOrder, env, idempotencyKey: `studio-new-order/${orderId}` });
      const { error: sentError } = await supabase.from('orders').update({ studio_email_sent_at: new Date().toISOString() })
        .eq('id', orderId).eq('paid_processing_claim', claim);
      if (sentError) throw sentError;
    }
    const { data: finished, error: finishError } = await supabase.from('orders')
      .update({ paid_processing_completed_at: new Date().toISOString(), paid_processing_claim: null })
      .eq('id', orderId).eq('status', 'paid').eq('paid_processing_claim', claim).select('id');
    if (finishError) throw finishError;
    return (finished?.length ?? 0) > 0;
  } finally {
    // On error, keep completed_at NULL and make the work immediately retryable.
    const { error: releaseError } = await supabase.from('orders').update({ paid_processing_claim: null })
      .eq('id', orderId).eq('paid_processing_claim', claim);
    if (releaseError) console.error('[paid-order] Could not release processing lease', orderId, releaseError);
  }
}
