import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getInPost } from '@/lib/inpost';
import { handleStripeEvent } from '@/lib/webhook';
import { createOrderInvoice } from '@/lib/invoice';
import { createOrderShipment } from '@/lib/shipment';
import { emailNewOrderToStudio } from '@/lib/email';
import { isNonRetryableShipxError, shouldRethrowShipmentError } from '@/lib/shipx-errors';
import type { OrderForShipment } from '@/lib/shipx';
import { sendPurchaseConversions, type ConversionOrder } from '@/lib/marketing/conversions';

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

      if (newSale) {
        try {
          const { data: orderRow, error: orderErr } = await supabase
            .from('orders')
            .select('id, email, total, currency, delivery_method, receiver_first_name, receiver_last_name, inpost_target_point')
            .eq('id', orderId)
            .single();
          if (orderErr) throw new Error(`load order failed for ${orderId}: ${orderErr.message}`);
          const { data: itemRows, error: itemsErr } = await supabase
            .from('order_items')
            .select('product_id, unit_price')
            .eq('order_id', orderId);
          if (itemsErr) throw new Error(`load order_items failed for ${orderId}: ${itemsErr.message}`);
          if (orderRow) {
            const notifyOrder = {
              order: {
                ...(orderRow as {
                  id: string; email: string | null; total: number; currency: string;
                  delivery_method: string; receiver_first_name: string | null;
                  receiver_last_name: string | null; inpost_target_point: string | null;
                }),
                items: (itemRows as Array<{ product_id: string; unit_price: number }> | null) ?? [],
              },
            };
            // Best-effort with bounded retries: this fires once (gated on newSale,
            // so retried/duplicate webhook deliveries won't re-notify), which means
            // a transient Resend blip would otherwise lose the notification for good.
            // A few quick retries survive transient failures without risking dupes;
            // the operational label email (InPost webhook) remains the backstop.
            let sent = false;
            for (let attempt = 0; attempt < 3 && !sent; attempt++) {
              try {
                await emailNewOrderToStudio(notifyOrder);
                sent = true;
              } catch (err) {
                if (attempt === 2) throw err;
                await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
              }
            }
          }
        } catch (err) {
          console.error('emailNewOrderToStudio failed for', orderId, err);
        }
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
                  'receiver_phone, inpost_target_point, shipping_address, inpost_shipment_id, ' +
                  'inpost_dispatch_order_id',
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
          saveDispatchOrderId: async (orderId, dispatchOrderId) => {
            const { error } = await supabase
              .from('orders')
              .update({ inpost_dispatch_order_id: dispatchOrderId })
              .eq('id', orderId)
              .is('inpost_dispatch_order_id', null);
            if (error) throw error;
          },
          inpost: getInPost(),
        });
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
            ? err.code
            : null;
        console.error(
          JSON.stringify({
            event: 'createOrderShipment_failed',
            payment_intent_id: pi,
            shipx_error: code,
            non_retryable: isNonRetryableShipxError(err),
          }),
          err,
        );
        // missing_trucker_id = InPost org courier dispatch not configured — retries cannot fix it.
        if (!shouldRethrowShipmentError(err)) return;
        throw err;
      }
    },
    revalidate: (tag) => revalidateTag(tag, 'max'),
    trackPurchase: async (pi) => {
      try {
        const metaToken = env.META_CAPI_ACCESS_TOKEN;
        const ga4Secret = env.GA4_API_SECRET;
        const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
        const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;

        const metaConfig = (metaToken && pixelId)
          ? { pixelId, accessToken: metaToken, ...(env.META_TEST_EVENT_CODE ? { testEventCode: env.META_TEST_EVENT_CODE } : {}) }
          : undefined;
        const ga4Config = (ga4Secret && measurementId)
          ? { measurementId, apiSecret: ga4Secret }
          : undefined;

        if (!metaConfig && !ga4Config) return;

        await sendPurchaseConversions(pi, {
          loadOrder: async (paymentIntentId) => {
            const { data } = await supabase
              .from('orders')
              .select(
                'id, payment_intent_id, status, subtotal, shipping, total, currency, email, ' +
                  'receiver_first_name, receiver_last_name, receiver_phone, shipping_address, marketing',
              )
              .eq('payment_intent_id', paymentIntentId)
              .single();
            if (!data) return null;
            const orderRow = data as unknown as { id: string } & Omit<ConversionOrder, 'items'>;
            const { data: itemRows } = await supabase
              .from('order_items')
              .select('product_id, unit_price')
              .eq('order_id', orderRow.id);
            return {
              ...orderRow,
              items: (itemRows as ConversionOrder['items'] | null) ?? [],
            };
          },
          metaConfig,
          ga4Config,
        });
      } catch (err) {
        console.error('trackPurchase failed for', pi, err);
      }
    },
  });

  return NextResponse.json({ received: true });
}
