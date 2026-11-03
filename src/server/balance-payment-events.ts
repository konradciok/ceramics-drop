import type Stripe from 'stripe';
import { completePaidOrder, type PaidOrderDeps } from './complete-paid-order';
import { settleGiftCardStripePayment } from './gift-card-checkout';
import { reconcileBalanceRefunds, finishBalanceRefund } from './balance-refunds';

export async function abortBalanceOrder(orderId: string, intentId: string | null, deps: Pick<PaidOrderDeps, 'supabase'>): Promise<void> {
  const result = await deps.supabase.rpc('abort_balance_order', { p_order_id: orderId, p_intent_id: intentId });
  if (result.error) throw result.error;
}

/** Recover a PI whose creation succeeded but the following DB write was lost.
 * Metadata alone never authorizes payment: amount, currency and stored order
 * identity are verified, and a different existing PI is never overwritten. */
async function findBalanceOrder(intent: Stripe.PaymentIntent, deps: PaidOrderDeps) {
  const { supabase } = deps;
  let result = await supabase.from('orders').select('id,gift_card_id,status,payment_intent_id,currency,cash_amount,refund_pending_at')
    .eq('payment_intent_id', intent.id).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data && intent.metadata.gift_card_payment === '1' && intent.metadata.order_id) {
    result = await supabase.from('orders').select('id,gift_card_id,status,payment_intent_id,currency,cash_amount,refund_pending_at')
      .eq('id', intent.metadata.order_id).maybeSingle();
    if (result.error) throw result.error;
    const order = result.data;
    if (!order?.gift_card_id || order.cash_amount !== intent.amount || order.currency !== intent.currency) throw new Error('Balance payment identity mismatch');
    if (order.payment_intent_id && order.payment_intent_id !== intent.id) throw new Error('Balance payment intent conflict');
    const saved = await supabase.from('orders').update({ payment_intent_id: intent.id })
      .eq('id', order.id).is('payment_intent_id', null).select('id');
    if (saved.error) throw saved.error;
    if (!saved.data?.length) {
      const bound = await supabase.from('orders').select('payment_intent_id').eq('id', order.id).single();
      if (bound.error || bound.data?.payment_intent_id !== intent.id) throw new Error('Balance payment intent conflict');
    }
  }
  return result.data?.gift_card_id ? result.data : null;
}

async function compensateBalancePayment(orderId: string, intent: Stripe.PaymentIntent, deps: PaidOrderDeps) {
  let confirmed = 0;
  let pending = false;
  for await (const refund of deps.stripe.refunds.list({ payment_intent: intent.id, limit: 100 })) {
    if (refund.status === 'succeeded') confirmed += refund.amount;
    else if (refund.status !== 'failed' && refund.status !== 'canceled') pending = true;
  }
  if (pending) throw new Error('Balance compensation pending');
  if (confirmed < intent.amount_received) {
    const refund = await deps.stripe.refunds.create({ payment_intent: intent.id }, { idempotencyKey: `balance_compensate_${orderId}` });
    if (refund.status !== 'succeeded') throw new Error('Balance compensation pending');
  }
  await abortBalanceOrder(orderId, intent.id, deps);
}

export async function processBalanceIntent(intent: Stripe.PaymentIntent, deps: PaidOrderDeps): Promise<boolean> {
  const order = await findBalanceOrder(intent, deps);
  if (!order) return false;
  if (intent.status === 'canceled') {
    await abortBalanceOrder(order.id, intent.id, deps);
    return true;
  }
  if (intent.status !== 'succeeded') return true; // decline/processing retain holds
  if (order.status === 'failed' || order.status === 'expired') throw new Error('Succeeded balance payment on terminal order requires review');
  if (order.status === 'refunded') { await finishBalanceRefund(order.id, deps); return true; }
  if (order.refund_pending_at) { await compensateBalancePayment(order.id, intent, deps); return true; }
  try {
    if (await settleGiftCardStripePayment(intent, deps.supabase) !== order.id) throw new Error('Balance payment binding lost');
  } catch (error) {
    // A lapsed ceramic hold / competing private-sale payment cannot be
    // fulfilled. Fence settlement BEFORE initiating its full cash refund.
    const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
    if (!message.includes('ceramic_reservation_lost') && !message.includes('private_sales_one_paid_order')) throw error;
    const marked = await deps.supabase.from('orders').update({ refund_pending_at: new Date().toISOString() })
      .eq('id', order.id).eq('status', 'pending').select('id');
    if (marked.error || !marked.data?.length) throw new Error('Balance compensation claim failed');
    await compensateBalancePayment(order.id, intent, deps);
    return true;
  }
  // Refund may precede success delivery; converge it before any fulfilment.
  await reconcileBalanceRefunds(order.id, intent.id, deps);
  await completePaidOrder(order.id, deps);
  return true;
}

/** Runs INSIDE the existing webhook-events lease. Returning true prevents the
 * legacy cash-only refund handler from relisting a partially refunded order. */
export async function handleBalancePaymentEvent(event: Stripe.Event, deps: PaidOrderDeps): Promise<boolean> {
  if (event.type.startsWith('payment_intent.')) {
    const snapshot = event.data.object as Stripe.PaymentIntent;
    if (snapshot.metadata?.gift_card_payment !== '1') return false;
    const current = await deps.stripe.paymentIntents.retrieve(snapshot.id);
    return processBalanceIntent(current, deps);
  }
  if (event.type !== 'charge.refunded' && event.type !== 'charge.dispute.closed') return false;
  const object = event.data.object as Stripe.Charge | Stripe.Dispute;
  const pi = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
  if (!pi) return false;
  const intent = await deps.stripe.paymentIntents.retrieve(pi);
  if (intent.metadata.gift_card_payment !== '1') return false;
  if (event.type === 'charge.dispute.closed') {
    const dispute = object as Stripe.Dispute;
    if (dispute.status !== 'lost') return true;
    // Disputes can cover less than the cash payment. Keep this path fenced
    // from legacy full-order relisting until the operator resolves the loss.
    throw new Error(`Balance payment dispute requires review: ${dispute.id}`);
  }
  return processBalanceIntent(intent, deps);
}
