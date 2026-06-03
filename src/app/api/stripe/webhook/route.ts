import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getInPost } from '@/lib/inpost';
import { handleStripeEvent } from '@/lib/webhook';
import { createOrderInvoice } from '@/lib/invoice';
import { createOrderShipment } from '@/lib/shipment';
import type { OrderForShipment } from '@/lib/shipx';

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
      // Email + delivery details were captured at checkout and already persisted,
      // so we only flip the status here. Only the first 'pending'→'paid'
      // transition returns a row (idempotency).
      const { data } = await supabase
        .from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id') as { data: Array<{ id: string }> | null };
      if (!data || data.length === 0) return false;
      const orderId = data[0].id;
      await supabase
        .from('piece_state')
        .update({ status: 'sold', reserved_until: null })
        .eq('order_id', orderId);
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
    createInvoice: async (pi) => {
      // Invoicing must never fail the webhook: the sale is already recorded
      // (markPaid committed). A throw here would 500 the webhook, and Stripe's
      // retry would no-op markPaid (idempotent) — permanently losing the
      // invoice/receipt. Swallow + log so the payment is acknowledged.
      try {
        await createOrderInvoice(pi);
      } catch (err) {
        console.error('createOrderInvoice failed for', pi, err);
      }
    },
    createShipment: async (pi) => {
      // Like invoicing, shipment creation must never fail the webhook — the sale
      // is committed. On a throw the label simply isn't created yet; swallow + log.
      try {
        await createOrderShipment(pi, {
          loadOrder: async (paymentIntentId) => {
            const { data } = await supabase
              .from('orders')
              .select(
                'id, delivery_method, email, receiver_first_name, receiver_last_name, ' +
                  'receiver_phone, inpost_target_point, shipping_address, inpost_shipment_id',
              )
              .eq('payment_intent_id', paymentIntentId)
              .single();
            return (data as OrderForShipment | null) ?? null;
          },
          saveShipment: async (orderId, d) => {
            await supabase
              .from('orders')
              .update({
                inpost_shipment_id: d.shipmentId,
                inpost_tracking_number: d.trackingNumber,
                delivery_status: d.status,
              })
              .eq('id', orderId);
          },
          inpost: getInPost(),
        });
      } catch (err) {
        console.error('createOrderShipment failed for', pi, err);
      }
    },
    revalidate: (tag) => revalidateTag(tag, 'max'),
  });

  return NextResponse.json({ received: true });
}
