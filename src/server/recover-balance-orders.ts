import { completePaidOrder, type PaidOrderDeps } from './complete-paid-order';
import { ensureBalanceIntent } from './gift-card-checkout';
import { abortBalanceOrder, processBalanceIntent } from './balance-payment-events';
import { finishBalanceRefund, refundBalanceOrder } from './balance-refunds';
import { captureWorkerAlert } from '@/lib/worker-sentry';

/** Each row is independent: one payment requiring review cannot starve others. */
export async function recoverBalanceOrders(deps: PaidOrderDeps): Promise<void> {
  const { supabase } = deps;
  const paid = await supabase.from('orders').select('id').eq('status', 'paid')
    .or('gift_card_id.not.is.null,fulfilment_type.eq.giftcard').is('paid_processing_completed_at', null).order('created_at').limit(100);
  const pending = await supabase.from('orders').select('id,payment_intent_id,cash_amount,balance_intent_started_at')
    .eq('status', 'pending').not('gift_card_id', 'is', null)
    .lt('created_at', new Date(Date.now() - 3600_000).toISOString()).order('created_at').limit(100);
  const refunds = await supabase.from('gift_card_refunds').select('id,order_id,amount').eq('status', 'pending').order('created_at').limit(100);
  const refunded = await supabase.from('orders').select('id').eq('status', 'refunded').not('gift_card_id', 'is', null)
    .is('balance_refund_completed_at', null).order('created_at').limit(100);
  for (const result of [paid, pending, refunds, refunded]) if (result.error) throw result.error;
  async function run(orderId: string, work: () => Promise<unknown>) {
    try { await work(); }
    catch (error) {
      await captureWorkerAlert(deps.env, { message: 'balance_order_recovery_failed', level: 'error', extra: { orderId, error: String(error) } });
    }
  }
  for (const order of paid.data ?? []) await run(order.id, () => completePaidOrder(order.id, deps));
  for (const order of pending.data ?? []) await run(order.id, async () => {
    if (!order.payment_intent_id && !order.balance_intent_started_at) {
      // No external payment has begun. The RPC fences this against creation
      // and a full-balance settlement that races the sweep.
      await abortBalanceOrder(order.id, null, deps);
      return;
    }
    let intent;
    if (!order.payment_intent_id && Date.now() - Date.parse(order.balance_intent_started_at) > 23 * 3600_000) {
      const found = await deps.stripe.paymentIntents.search({ query: `metadata['order_id']:'${order.id}' AND metadata['gift_card_payment']:'1'`, limit: 2 });
      if (found.data.length !== 1 || found.has_more) throw new Error('Payment outcome unknown; balance retained for review');
      intent = found.data[0];
    } else intent = await ensureBalanceIntent(order, deps);
    if (intent.status !== 'succeeded' && intent.status !== 'canceled' && intent.status !== 'processing' && intent.status !== 'requires_capture') {
      // A concurrent success makes cancel throw. The next sweep reads its
      // actual status; an uncertain cancellation never frees a balance.
      intent = await deps.stripe.paymentIntents.cancel(intent.id);
    }
    await processBalanceIntent(intent, deps);
  });
  for (const refund of refunds.data ?? []) await run(refund.order_id, () => refundBalanceOrder(refund.order_id, refund.id, refund.amount, deps));
  for (const order of refunded.data ?? []) await run(order.id, () => finishBalanceRefund(order.id, deps));
}
