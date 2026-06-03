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

      // 2. Transition pending→paid (idempotent CAS). Only the first delivery wins the row; a
      //    retry that finds the order already 'paid' re-reads it and re-runs the fulfillment
      //    reconcile below, so a crash mid-fulfillment can never strand a paid-but-unverified
      //    order (the reconcile in steps 3-5 is re-entrant).
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

      let orderId: string;
      let newSale = false;
      if (orderData && orderData.length > 0) {
        orderId = orderData[0].id;
        newSale = true;
      } else {
        // Already past 'pending'. Re-read to reconcile a possibly-incomplete prior attempt.
        // Only a 'paid' order needs reconciling; 'failed'/'expired' are terminal.
        const { data: existing } = await supabase
          .from('orders')
          .select('id, status')
          .eq('payment_intent_id', pi)
          .single() as { data: { id: string; status: string } | null };
        if (!existing || existing.status !== 'paid') return false;
        orderId = existing.id;
      }

      // 3. Claim any pieces STILL reserved to this order (idempotent: a retry claims 0).
      await supabase
        .from('piece_state')
        .update({ status: 'sold', reserved_until: null })
        .eq('order_id', orderId)
        .eq('status', 'reserved');

      // 4. Verify fulfillment by counting pieces actually SOLD to this order (re-entrant: correct
      //    on the first run AND on any retry). A failed/null count must NOT be read as 0 — that
      //    would treat an unfulfilled order as complete — so fail-fast and let Stripe retry.
      const { count: fulfilledCount, error: fulfilledErr } = await supabase
        .from('piece_state')
        .select('*', { count: 'exact', head: true })
        .eq('order_id', orderId)
        .eq('status', 'sold');
      const { count: expectedCount, error: expectedErr } = await supabase
        .from('order_items')
        .select('*', { count: 'exact', head: true })
        .eq('order_id', orderId);
      if (fulfilledErr || expectedErr || fulfilledCount == null || expectedCount == null) {
        throw new Error(`fulfillment count failed for order ${orderId}`);
      }

      // 5. Shortfall (a hold expired and a piece was reassigned): refund + release + fail.
      //    Leaving status='paid' if we crash here is safe — a retry re-runs this same reconcile.
      if (fulfilledCount < expectedCount) {
        // Idempotency key collapses duplicate refunds across webhook retries.
        try {
          await stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `refund_${pi}` });
        } catch (err) {
          console.error('refund failed for', pi, err);
        }
        // Release any pieces we claimed so they aren't stranded as sold.
        await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', orderId)
          .eq('status', 'sold');
        // Mark the order failed (createOrderInvoice gates on status='paid', so no invoice).
        await supabase
          .from('orders')
          .update({ status: 'failed' })
          .eq('id', orderId);
        return false; // no sale, no invoice
      }

      // 6. Fully fulfilled — revalidate inventory only on the first transition.
      return newSale;
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
