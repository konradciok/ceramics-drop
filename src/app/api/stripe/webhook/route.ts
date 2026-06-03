import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { handleStripeEvent } from '@/lib/webhook';
import { createOrderInvoice } from '@/lib/invoice';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'no_signature' }, { status: 400 });

  const body = await req.text();
  const stripe = getStripe();
  const { env } = getCloudflareContext();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  await handleStripeEvent(event, {
    markPaid: async (pi) => {
      // 1. Pull email + shipping that the Payment/Address/LinkAuthentication Elements attached.
      let email: string | null = null;
      let shippingAddress: Stripe.PaymentIntent['shipping'] | null = null;
      try {
        const full = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge'] });
        const charge = full.latest_charge as Stripe.Charge | null;
        email = charge?.billing_details?.email ?? full.receipt_email ?? null;
        shippingAddress = full.shipping ?? null;
      } catch {
        // If retrieval fails, proceed without email/shipping (invoice will be skipped).
      }

      // 2. Transition pending→paid (idempotent): only the first call returns a row.
      const { data: orderData } = await supabase
        .from('orders')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          email,
          shipping_address: shippingAddress,
        })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id') as { data: Array<{ id: string }> | null };
      if (!orderData || orderData.length === 0) return false; // already processed
      const orderId = orderData[0].id;

      // 3. Claim only pieces STILL reserved to this order (guard against hold expiry + reassignment).
      const { data: claimedData } = await supabase
        .from('piece_state')
        .update({ status: 'sold', reserved_until: null })
        .eq('order_id', orderId)
        .eq('status', 'reserved')
        .select('product_id') as { data: Array<{ product_id: string }> | null };
      const claimedCount = claimedData?.length ?? 0;

      // 4. Expected count from order_items.
      const { count: expectedCount } = await supabase
        .from('order_items')
        .select('*', { count: 'exact', head: true })
        .eq('order_id', orderId);

      // 5. If we couldn't fulfill all items, refund + release + fail the order.
      if (claimedCount < (expectedCount ?? 0)) {
        // Best-effort refund — failure surfaces in Stripe Dashboard.
        try { await stripe.refunds.create({ payment_intent: pi }); } catch {}
        // Release any pieces we just claimed so they aren't stranded as sold.
        await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', orderId)
          .eq('status', 'sold');
        // Mark the order failed.
        await supabase
          .from('orders')
          .update({ status: 'failed' })
          .eq('id', orderId);
        return false; // no sale, no invoice
      }

      // 6. Fully fulfilled — new sale.
      return true;
    },
    releaseHold: async (pi) => {
      const { data } = await supabase
        .from('orders')
        .update({ status: 'failed' })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id');
      const rows = data as Array<{ id: string }> | null;
      if (rows && rows.length > 0) {
        await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', rows[0].id);
      }
    },
    ensureInvoiced: async (pi) => {
      // Invoicing must never fail the webhook: the sale is already recorded.
      // createOrderInvoice is now idempotent (checks invoiced_at), so retries
      // safely re-attempt a previously failed invoice send.
      try {
        await createOrderInvoice(pi);
      } catch (err) {
        console.error('createOrderInvoice failed for', pi, err);
      }
    },
    revalidate: (tag) => revalidateTag(tag, 'max'),
  });

  return NextResponse.json({ received: true });
}
