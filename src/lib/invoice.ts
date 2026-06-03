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
  if (!order || order.status !== 'paid' || order.invoiced_at || !order.email) return;

  const { data: items } = await supabase
    .from('order_items').select('*').eq('order_id', order.id);
  if (!items || items.length === 0) return;

  const addr = order.shipping_address as {
    street?: string;
    building_number?: string;
    city?: string;
    post_code?: string;
    country_code?: string;
  } | null;
  const line1 = `${addr?.street ?? ''} ${addr?.building_number ?? ''}`.trim();
  const customerShipping =
    addr && line1
      ? {
          name:
            `${order.receiver_first_name ?? ''} ${order.receiver_last_name ?? ''}`.trim() ||
            (order.email as string),
          phone: order.receiver_phone ?? undefined,
          address: {
            line1,
            city: addr.city,
            postal_code: addr.post_code,
            country: addr.country_code ?? 'PL',
          },
        }
      : undefined;

  const customer = await stripe.customers.create({
    email: order.email,
    shipping: customerShipping,
    preferred_locales: ['pl'],
  }, { idempotencyKey: `cust_${order.id}` });

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
    }, { idempotencyKey: `ii_${order.id}_${it.product_id}` });
  }
  if (order.shipping > 0) {
    const shippingLabel =
      order.delivery_method === 'paczkomat'
        ? 'Wysyłka — Paczkomat InPost'
        : 'Wysyłka — Kurier InPost';
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: order.shipping,
      currency: 'pln',
      description: shippingLabel,
    }, { idempotencyKey: `ii_${order.id}_shipping` });
  }

  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'charge_automatically',
    auto_advance: false,
    metadata: { payment_intent_id: paymentIntentId, order_id: order.id },
  }, { idempotencyKey: `inv_${order.id}` });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id as string);
  await stripe.invoices.pay(finalized.id as string, { paid_out_of_band: true } as Stripe.InvoicePayParams);
  await stripe.invoices.sendInvoice(finalized.id as string);
  const { error: recordErr } = await supabase
    .from('orders')
    .update({ invoiced_at: new Date().toISOString(), invoice_id: finalized.id as string })
    .eq('id', order.id);
  if (recordErr) {
    throw new Error(`failed to record invoicing for order ${order.id}: ${recordErr.message}`);
  }
}
