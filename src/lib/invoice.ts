import type Stripe from 'stripe';
import { getStripe } from './stripe';
import { getSupabaseAdmin } from './supabase';
import { getProductById, CATEGORIES } from './products';
import { getPrintById } from './prints';
import { variantLabel } from './print-cart';
import type { PrintVariantSelection } from './types';
import plMessages from '../../messages/pl.json';
import enMessages from '../../messages/en.json';
import esMessages from '../../messages/es.json';
import deMessages from '../../messages/de.json';

const MESSAGES = { pl: plMessages, en: enMessages, es: esMessages, de: deMessages } as const;

const SHIPPING_LABELS: Record<string, { paczkomat: string; kurier: string }> = {
  pl: { paczkomat: 'Wysyłka — Paczkomat InPost', kurier: 'Wysyłka — Kurier InPost' },
  en: { paczkomat: 'Shipping — Paczkomat InPost', kurier: 'Shipping — InPost Courier' },
  es: { paczkomat: 'Envío — Paczkomat InPost', kurier: 'Envío — Mensajería InPost' },
  de: { paczkomat: 'Versand — Paczkomat InPost', kurier: 'Versand — InPost Kurier' },
};

/**
 * Build a no-VAT invoice for a paid order and email it via Stripe.
 *
 * Flow notes (each step verified against the live test-mode API):
 * - The invoice is created FIRST and items are attached directly to it.
 *   Relying on pending invoice items is a trap: `invoices.create` defaults
 *   `pending_invoice_items_behavior` to `exclude`, which produced 0 zł invoices
 *   that auto-paid on finalization and made the explicit `pay()` throw
 *   "Invoice is already paid" — no invoice was ever recorded or emailed.
 * - `collection_method` must be `send_invoice`: Stripe refuses to manually send
 *   `charge_automatically` invoices regardless of status.
 * - `currency: 'pln'` must be explicit — the account default (EUR) otherwise
 *   conflicts with the PLN invoice items.
 * - Order matters: finalize → pay(paid_out_of_band) → sendInvoice. Sending an
 *   already-paid send_invoice invoice is allowed and emails a 0-due document.
 * - Webhook retries replay POSTs from Stripe's idempotency cache, which returns
 *   the ORIGINAL response snapshot — statuses are re-read with a live retrieve
 *   before deciding which steps still need to run.
 */
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

  // `gb` is retired as a locale, but legacy orders persisted before the merge
  // may still carry `locale = 'gb'` — invoice those in English, not Polish.
  const invoiceLocale = (order.locale as string) === 'en' || (order.locale as string) === 'gb' ? 'en'
    : (order.locale as string) === 'es' ? 'es'
    : (order.locale as string) === 'de' ? 'de'
    : 'pl';

  const messages = MESSAGES[invoiceLocale as keyof typeof MESSAGES] ?? plMessages;
  const orderCurrency: 'pln' | 'eur' | 'gbp' =
    order.currency === 'eur' ? 'eur' : order.currency === 'gbp' ? 'gbp' : 'pln';

  const existingList = await stripe.customers.list({ email: order.email as string, limit: 1 });
  let customer: Stripe.Customer;
  if (existingList.data.length > 0) {
    customer = await stripe.customers.update(existingList.data[0].id, {
      ...(customerShipping ? { shipping: customerShipping } : {}),
      preferred_locales: [invoiceLocale],
    });
  } else {
    customer = await stripe.customers.create(
      { email: order.email, shipping: customerShipping, preferred_locales: [invoiceLocale] },
      { idempotencyKey: `cust_${order.id}` },
    );
  }

  // "2" prefixes: the v1 flow left idempotency entries with different params
  // (pending-item style); reusing those keys would be rejected by Stripe.
  let invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: 30,
    currency: orderCurrency,
    auto_advance: false,
    metadata: { payment_intent_id: paymentIntentId, order_id: order.id },
  }, { idempotencyKey: `inv2_${order.id}` });

  // Re-read live state: an idempotent replay returns the at-creation (draft)
  // snapshot even when the invoice has since been finalized or paid.
  invoice = await stripe.invoices.retrieve(invoice.id as string);

  if (invoice.status === 'draft') {
    for (const it of items) {
      const productNames = messages.product as Record<string, string>;
      const variant = (it.variant ?? null) as (PrintVariantSelection & { prodigiSku: string }) | null;
      let label: string;
      if (variant) {
        // Fine-art print: design name + chosen variant. The SKU also disambiguates
        // the idempotency key so two variants of the same design both invoice.
        const design = getPrintById(it.product_id);
        const printName = productNames['print'] ?? 'Fine-art print';
        label = `${printName} Nº ${design?.num ?? ''}`.trim()
          + ` — ${variantLabel(variant, invoiceLocale)} (${variant.prodigiSku})`;
      } else {
        const product = getProductById(it.product_id);
        label = product
          ? `${productNames[CATEGORIES[product.category].singularKey] ?? CATEGORIES[product.category].singularKey} Nº ${product.num}`
          : it.product_id;
      }
      await stripe.invoiceItems.create({
        customer: customer.id,
        invoice: invoice.id as string,
        amount: it.unit_price,
        currency: orderCurrency,
        description: label,
      }, { idempotencyKey: `ii2_${order.id}_${variant?.prodigiSku ?? it.product_id}` });
    }
    if (order.shipping > 0) {
      const labels = SHIPPING_LABELS[invoiceLocale] ?? SHIPPING_LABELS.pl;
      const shippingLabel =
        order.delivery_method === 'paczkomat' ? labels.paczkomat : labels.kurier;
      await stripe.invoiceItems.create({
        customer: customer.id,
        invoice: invoice.id as string,
        amount: order.shipping,
        currency: orderCurrency,
        description: shippingLabel,
      }, { idempotencyKey: `ii2_${order.id}_shipping` });
    }

    // Guard against drift before the invoice becomes immutable. A mismatch
    // leaves the draft in place; the webhook retry lands here again.
    invoice = await stripe.invoices.retrieve(invoice.id as string);
    if (invoice.total !== order.total) {
      throw new Error(
        `invoice ${invoice.id} total ${invoice.total} != order ${order.id} total ${order.total}`,
      );
    }
    invoice = await stripe.invoices.finalizeInvoice(
      invoice.id as string, {}, { idempotencyKey: `fin_${order.id}` },
    );
  }

  if (invoice.status === 'open') {
    invoice = await stripe.invoices.pay(
      invoice.id as string,
      { paid_out_of_band: true } as Stripe.InvoicePayParams,
      { idempotencyKey: `payinv_${order.id}` },
    );
  }

  if (invoice.status !== 'paid') {
    throw new Error(`invoice ${invoice.id} in unexpected status ${invoice.status}`);
  }

  await stripe.invoices.sendInvoice(
    invoice.id as string, {}, { idempotencyKey: `sendinv_${order.id}` },
  );

  const { error: recordErr } = await supabase
    .from('orders')
    .update({ invoiced_at: new Date().toISOString(), invoice_id: invoice.id as string })
    .eq('id', order.id);
  if (recordErr) {
    throw new Error(`failed to record invoicing for order ${order.id}: ${recordErr.message}`);
  }
}
