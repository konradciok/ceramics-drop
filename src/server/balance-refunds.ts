import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cancelPrintFulfilment } from './fulfilment/cancel-print';

type RefundDeps = { supabase: SupabaseClient; stripe: Stripe; env: CloudflareEnv };
type BalanceRefund = { id: string; order_id: string; amount: number; cash_amount: number; gift_card_amount: number; status: string; stripe_refund_id: string | null };

export async function finishBalanceRefund(orderId: string, deps: RefundDeps): Promise<void> {
  const { data: order, error } = await deps.supabase.from('orders').select('status').eq('id', orderId).single();
  if (error) throw error;
  if (order.status !== 'refunded') return;
  const result = await deps.supabase.rpc('release_refunded_balance_inventory', { p_order_id: orderId });
  if (result.error) throw result.error;
  const cancellation = await cancelPrintFulfilment(orderId, deps.env);
  if (cancellation === 'best_effort_failed') throw new Error('Balance refund fulfilment cancellation requires retry');
  const completed = await deps.supabase.from('orders').update({ balance_refund_completed_at: new Date().toISOString() })
    .eq('id', orderId).eq('status', 'refunded');
  if (completed.error) throw completed.error;
}

/** A stable refund UUID binds the amount; retries cannot create another refund. */
export async function refundBalanceOrder(orderId: string, refundId: string, amount: number | null, deps: RefundDeps): Promise<'pending' | 'settled'> {
  const { supabase, stripe } = deps;
  const prepared = amount === null
    ? await supabase.rpc('prepare_remaining_balance_refund', { p_order_id: orderId, p_refund_id: refundId })
    : await supabase.rpc('prepare_gift_card_refund', { p_order_id: orderId, p_refund_id: refundId, p_amount: amount });
  if (prepared.error || !prepared.data) throw new Error(prepared.error?.message ?? 'Refund preparation failed');
  const refund = prepared.data as BalanceRefund;
  if (refund.status === 'settled') {
    await finishBalanceRefund(orderId, deps);
    return 'settled';
  }
  let stripeRefundId: string | null = null;
  if (refund.cash_amount > 0) {
    const { data: order, error } = await supabase.from('orders').select('payment_intent_id').eq('id', orderId).single();
    if (error || !order?.payment_intent_id) throw new Error('Refund payment could not be loaded');
    // Search existing refunds before create: Stripe idempotency expires after
    // 24h, whereas this durable refund UUID must remain single-use forever.
    let existing: Stripe.Refund | undefined;
    for await (const candidate of stripe.refunds.list({ payment_intent: order.payment_intent_id, limit: 100 })) {
      if (candidate.metadata?.balance_refund_id === refundId) { existing = candidate; break; }
    }
    const cash = existing ?? await stripe.refunds.create({
      payment_intent: order.payment_intent_id, amount: refund.cash_amount,
      metadata: { balance_refund_id: refundId, order_id: orderId },
    }, { idempotencyKey: `balance_refund_${refundId}` });
    if (cash.amount !== refund.cash_amount) throw new Error('Cash refund amount mismatch');
    if (cash.status === 'failed' || cash.status === 'canceled') throw new Error('Cash refund requires manual review');
    if (cash.status !== 'succeeded') return 'pending';
    stripeRefundId = cash.id;
  }
  const settled = await supabase.rpc('settle_gift_card_refund', {
    p_order_id: orderId, p_refund_id: refundId, p_stripe_refund_id: stripeRefundId,
  });
  if (settled.error) throw settled.error;
  await finishBalanceRefund(orderId, deps);
  return 'settled';
}

/** Use current confirmed refunds, not a possibly stale charge event snapshot. */
export async function reconcileBalanceRefunds(orderId: string, intentId: string, deps: RefundDeps): Promise<void> {
  let cashRefunded = 0;
  for await (const refund of deps.stripe.refunds.list({ payment_intent: intentId, limit: 100 })) {
    if (refund.status !== 'succeeded') continue;
    cashRefunded += refund.amount;
    const internalId = refund.metadata?.balance_refund_id;
    if (!internalId) continue;
    const { data: pending, error } = await deps.supabase.from('gift_card_refunds')
      .select('cash_amount').eq('id', internalId).eq('order_id', orderId).single();
    if (error || !pending || pending.cash_amount !== refund.amount) throw new Error('Unknown or mismatched balance refund');
    const settled = await deps.supabase.rpc('settle_gift_card_refund', {
      p_order_id: orderId, p_refund_id: internalId, p_stripe_refund_id: refund.id,
    });
    if (settled.error) throw settled.error;
  }
  if (cashRefunded > 0) {
    const result = await deps.supabase.rpc('reconcile_balance_cash_refund', { p_order_id: orderId, p_cash_refunded: cashRefunded });
    if (result.error) throw result.error;
  }
  await finishBalanceRefund(orderId, deps);
}
