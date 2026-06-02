import type Stripe from 'stripe';
import { getStripe } from './stripe';
import { getSupabaseAdmin } from './supabase';
import { getProductById, CATEGORIES } from './products';
import plMessages from '../../messages/pl.json';

/** Build a no-VAT invoice for a paid order and email it via Stripe. */
export async function createOrderInvoice(paymentIntentId: string): Promise<void> {
  const stripe = getStripe();
  const supabase = getSupabaseAdmin();

  const { data: order } = await supabase
    .from('orders').select('*').eq('payment_intent_id', paymentIntentId).single();
  if (!order || !order.email) return; // no email collected → nothing to send

  const { data: items } = await supabase
    .from('order_items').select('*').eq('order_id', order.id);
  if (!items || items.length === 0) return;

  const customer = await stripe.customers.create({
    email: order.email,
    shipping: order.shipping_address ?? undefined,
    preferred_locales: ['pl'],
  });

  for (const it of items) {
    const product = getProductById(it.product_id);
    const productNames = plMessages.product as Record<string, string>;
    const label = product
      ? `${productNames[CATEGORIES[product.category].singularKey] ?? CATEGORIES[product.category].singularKey} Nº ${product.num}`
      : it.product_id;
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: it.unit_price,
      currency: 'pln',
      description: label,
    });
  }
  if (order.shipping > 0) {
    await stripe.invoiceItems.create({
      customer: customer.id, amount: order.shipping, currency: 'pln', description: 'Wysyłka kurierem',
    });
  }

  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'charge_automatically',
    auto_advance: false,
    metadata: { payment_intent_id: paymentIntentId, order_id: order.id },
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id as string);
  // Goods already paid via the PaymentIntent → record paid without charging again.
  await stripe.invoices.pay(finalized.id as string, { paid_out_of_band: true } as Stripe.InvoicePayParams);
  await stripe.invoices.sendInvoice(finalized.id as string);
}
