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
      const { data: orderData, error: orderErr } = (await supabase
        .from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };

      if (orderErr) throw new Error(`markPaid orders update failed: ${orderErr.message}`);

      let orderId: string;
      let newSale = false;
      if (orderData && orderData.length > 0) {
        orderId = orderData[0].id;
        newSale = true;
      } else {
        const { data: existing } = await supabase
          .from('orders')
          .select('id, status')
          .eq('payment_intent_id', pi)
          .single() as { data: { id: string; status: string } | null };
        if (!existing || existing.status !== 'paid') return false;
        orderId = existing.id;
      }

      await supabase
        .from('piece_state')
        .update({ status: 'sold', reserved_until: null })
        .eq('order_id', orderId)
        .eq('status', 'reserved');

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

      if (fulfilledCount < expectedCount) {
        try {
          await stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `refund_${pi}` });
        } catch (err) {
          console.error('refund failed for', pi, err);
        }
        await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', orderId)
          .eq('status', 'sold');
        await supabase.from('orders').update({ status: 'failed' }).eq('id', orderId);
        return false;
      }

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
          .eq('order_id', rows[0].id)
          .eq('status', 'reserved');
      }
    },
    releaseSale: async (pi) => {
      const { data } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'paid')
        .select('id');
      const rows = data as Array<{ id: string }> | null;
      if (!rows || rows.length === 0) return false;
      // Throw on a piece_state failure (don't return true): otherwise the caller
      // would revalidate inventory and advertise a piece as available while it is
      // still 'sold' in the DB. A 5xx makes Stripe retry until the relist sticks.
      const { error: pieceErr } = await supabase
        .from('piece_state')
        .update({ status: 'available', reserved_until: null, order_id: null })
        .eq('order_id', rows[0].id)
        .eq('status', 'sold');
      if (pieceErr) throw new Error(`releaseSale piece_state update failed: ${pieceErr.message}`);
      return true;
    },
    ensureInvoiced: async (pi) => {
      try {
        await createOrderInvoice(pi);
      } catch (err) {
        console.error('createOrderInvoice failed for', pi, err);
      }
    },
    createShipment: async (pi) => {
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
            const { error } = await supabase
              .from('orders')
              .update({
                inpost_shipment_id: d.shipmentId,
                inpost_tracking_number: d.trackingNumber,
                delivery_status: d.status,
              })
              .eq('id', orderId)
              .is('inpost_shipment_id', null);
            if (error) throw error;
          },
          inpost: getInPost(),
        });
      } catch (err) {
        console.error(
          JSON.stringify({ event: 'createOrderShipment_failed', payment_intent_id: pi }),
          err,
        );
        throw err;
      }
    },
    revalidate: (tag) => revalidateTag(tag, 'max'),
  });

  return NextResponse.json({ received: true });
}
