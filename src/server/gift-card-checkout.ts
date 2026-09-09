import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createGiftCardReceipt } from '@/lib/gift-card-receipt';
import { STRIPE_MINIMUM_MINOR, type GiftCardCurrency } from '@/lib/gift-card-balance';
import { completePaidOrder, type PaidOrderDeps } from './complete-paid-order';

export type BalanceOrderSnapshot = {
  id: string; currency: GiftCardCurrency; subtotal: number; shipping: number; total: number;
  shipping_method: string; delivery_method: string; fulfilment_type: string;
  email: string; receiver_first_name: string; receiver_last_name: string; receiver_phone: string | null;
  inpost_target_point: string | null; shipping_address: unknown; locale: string;
  marketing: unknown; private_sale_id: string | null; user_id: string | null;
};
type BalanceItem = { product_id: string; unit_price: number; variant: unknown };
type PreparedOrder = BalanceOrderSnapshot & { status: string; cash_amount: number; gift_card_amount: number; payment_intent_id: string | null; balance_intent_started_at: string | null };

function checked<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error || result.data == null) throw new Error(result.error?.message ?? 'Missing checkout result');
  return result.data;
}

export async function checkoutWithGiftCard(args: {
  order: BalanceOrderSnapshot; items: BalanceItem[]; code: string; privateToken: string | null;
  deps: PaidOrderDeps;
}): Promise<{ status: 'paid'; confirmation_url: string; gift_card_amount: number; cash_amount: number } |
  { status: 'requires_payment'; client_secret: string; gift_card_amount: number; cash_amount: number }> {
  const { order, items, code, privateToken, deps } = args;
  const { supabase, env, ctx } = deps;
  // Exclude capture timestamps/marketing cookies from retry identity. Everything
  // that affects prices, recipient, account ownership and the card is bound.
  const identity = { ...order, marketing: undefined };
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify({ order: identity, items, code, privateToken })))), b => b.toString(16).padStart(2,'0')).join('');
  const prepared = checked(await supabase.rpc('prepare_balance_order', {
    p_order: order, p_items: items, p_code: code, p_fingerprint: fingerprint,
    p_minimum_cash: STRIPE_MINIMUM_MINOR[order.currency], p_private_token: privateToken,
  })) as PreparedOrder;

  if (prepared.status === 'paid' || prepared.cash_amount === 0) {
    if (prepared.status !== 'paid') checked(await supabase.rpc('settle_gift_card', {
      p_order_id: order.id, p_payment_intent_id: null, p_cash_received: 0,
    }));
    // The paid row persists before side effects. Recovery also invokes this
    // function, so a lost request cannot lose fulfillment or confirmation.
    ctx.waitUntil(completePaidOrder(order.id, deps).catch(error => console.error('[paid-order] Work pending retry', order.id, error)));
    const receipt = await createGiftCardReceipt(order.id, env.SUPABASE_SERVICE_ROLE_KEY);
    const prefix = order.locale === 'pl' ? '' : `/${order.locale}`;
    return { status: 'paid', confirmation_url: `${prefix}/koszyk/potwierdzenie?order=${order.id}&receipt=${receipt}`,
      gift_card_amount: prepared.gift_card_amount, cash_amount: prepared.cash_amount };
  }

  const intent = await ensureBalanceIntent(prepared, deps);
  if (!intent.client_secret || intent.status === 'canceled') throw new Error('stripe_failed');
  return { status: 'requires_payment', client_secret: intent.client_secret,
    gift_card_amount: prepared.gift_card_amount, cash_amount: prepared.cash_amount };
}

export async function ensureBalanceIntent(prepared: Pick<PreparedOrder, 'id' | 'payment_intent_id'>, deps: PaidOrderDeps): Promise<Stripe.PaymentIntent> {
  const { supabase, stripe, env } = deps;
  let intent: Stripe.PaymentIntent;
  if (prepared.payment_intent_id) {
    intent = await stripe.paymentIntents.retrieve(prepared.payment_intent_id);
  } else {
    if (!env.STRIPE_PAYMENT_METHOD_CONFIGURATION_ID) throw new Error('stripe_failed');
    const current = checked(await supabase.rpc('begin_balance_intent', { p_order_id: prepared.id })) as PreparedOrder;
    if (current.payment_intent_id) return stripe.paymentIntents.retrieve(current.payment_intent_id);
    // A Stripe idempotency key is retained for at least 24h. After that,
    // recovery must locate the original PI; blindly recreating could charge twice.
    if (!current.balance_intent_started_at || Date.now() - Date.parse(current.balance_intent_started_at) > 23 * 3600_000) {
      throw new Error('payment_outcome_unknown');
    }
    intent = await stripe.paymentIntents.create({
      amount: current.cash_amount, currency: current.currency,
      payment_method_configuration: env.STRIPE_PAYMENT_METHOD_CONFIGURATION_ID,
      metadata: { order_id: current.id, gift_card_payment: '1', fulfilment_type: current.fulfilment_type },
    }, { idempotencyKey: `balance_pi_${current.id}` });
    const saved = await supabase.from('orders').update({ payment_intent_id: intent.id })
      .eq('id', current.id).eq('status','pending').is('payment_intent_id',null).select('id');
    if (saved.error) throw new Error('stripe_intent_persist_failed');
  }
  // Never release a hold on an ambiguous Stripe/DB failure. A retry reuses the
  // order and idempotency key; cancellation must be confirmed before release.
  return intent;
}

/** Confirm the actual Stripe amount before an atomic balance settlement. */
export async function settleGiftCardStripePayment(intent: Stripe.PaymentIntent, supabase: SupabaseClient): Promise<string | null> {
  const result = await supabase.from('orders').select('id,gift_card_id,currency,cash_amount').eq('payment_intent_id',intent.id).maybeSingle();
  if (result.error) throw result.error;
  const order = result.data;
  if (!order?.gift_card_id) return null;
  if (intent.status !== 'succeeded' || intent.currency !== order.currency || intent.amount_received !== order.cash_amount) throw new Error('gift_card_payment_mismatch');
  checked(await supabase.rpc('settle_gift_card',{ p_order_id: order.id,p_payment_intent_id:intent.id,p_cash_received:intent.amount_received }));
  return order.id;
}
