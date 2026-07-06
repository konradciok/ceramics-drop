import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { revalidateTag } from 'next/cache';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getInPost } from '@/lib/inpost';
import { handleStripeEvent } from '@/lib/webhook';
import { createOrderInvoice } from '@/lib/invoice';
import { createOrderShipment } from '@/lib/shipment';
import { emailNewOrderToStudio, emailOrderConfirmationToCustomer } from '@/lib/email';
import { sendPurchasedEvent } from '@/lib/resend-events';
import { isNonRetryableShipxError, shouldRethrowShipmentError } from '@/lib/shipx-errors';
import type { OrderForShipment } from '@/lib/shipx';
import { sendPurchaseConversions, type ConversionOrder } from '@/lib/marketing/conversions';
import { releaseTargetStatus, releaseReservedPieces } from '@/lib/piece-release';
import { countCeramicOrderItems, isUnderfulfilled, type CeramicCountClient } from '@/lib/fulfillment';
import { enqueueProdigi } from '@/server/fulfilment/enqueue';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    console.error('stripe webhook: missing stripe-signature header');
    Sentry.captureMessage('stripe_webhook_bad_signature');
    return NextResponse.json({ error: 'no_signature' }, { status: 400 });
  }

  const body = await req.text();
  const stripe = getStripe();
  const { env, ctx } = getCloudflareContext();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    console.error('stripe webhook: signature verification failed');
    Sentry.captureMessage('stripe_webhook_bad_signature');
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
        .select('id, private_sale_id')) as {
          data: Array<{ id: string; private_sale_id: string | null }> | null;
          error: { message: string } | null;
        };

      if (orderErr) throw new Error(`markPaid orders update failed: ${orderErr.message}`);

      let orderId: string;
      // Fetched up front (not just in the newSale branch) so the single-use token is
      // consumed on Stripe retries too, where the order is already `paid`.
      let privateSaleId: string | null = null;
      let newSale = false;
      if (orderData && orderData.length > 0) {
        orderId = orderData[0].id;
        privateSaleId = orderData[0].private_sale_id;
        newSale = true;
      } else {
        const { data: existing, error: existingErr } = await supabase
          .from('orders')
          .select('id, status, private_sale_id')
          .eq('payment_intent_id', pi)
          .single() as {
            data: { id: string; status: string; private_sale_id: string | null } | null;
            error: { code: string; message: string } | null;
          };
        // PGRST116 is PostgREST's zero-rows-from-.single() code — that's the genuine
        // "unknown payment_intent" case below. Any other error is a lookup failure
        // (DB hiccup) and must not masquerade as an unknown PI in Sentry.
        if (existingErr && existingErr.code !== 'PGRST116') {
          console.error('markPaid: order lookup failed for payment_intent', pi, existingErr);
          Sentry.captureMessage('stripe_webhook_order_lookup_failed');
          return false;
        }
        if (!existing) {
          // No order at all for this payment_intent — an orphaned PI or an event
          // from another environment pointed at this endpoint. Nothing to retry,
          // but silently dropping it hides a real misconfiguration.
          console.error('markPaid: no order found for payment_intent', pi);
          Sentry.captureMessage('stripe_webhook_unknown_payment_intent');
          return false;
        }
        if (existing.status !== 'paid') return false;
        orderId = existing.id;
        privateSaleId = existing.private_sale_id;
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
      // Count ONLY ceramic line items (variant IS NULL): each maps to a piece_state row.
      // Prints have no piece_state rows — counting them would make every print order look
      // under-fulfilled and trigger an auto-refund. Print-only orders: expected = 0 = fulfilled.
      const { count: expectedCount, error: expectedErr } = await countCeramicOrderItems(
        supabase as unknown as CeramicCountClient,
        orderId,
      );
      if (fulfilledErr || expectedErr || fulfilledCount == null || expectedCount == null) {
        throw new Error(`fulfillment count failed for order ${orderId}`);
      }

      if (isUnderfulfilled(fulfilledCount, expectedCount)) {
        try {
          await stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `refund_${pi}` });
        } catch (err) {
          console.error('refund failed for', pi, err);
        }
        await supabase
          .from('piece_state')
          .update({ status: releaseTargetStatus({ private_sale_id: privateSaleId }), reserved_until: null, order_id: null })
          .eq('order_id', orderId)
          .eq('status', 'sold');
        // CAS-guarded: if a fast `charge.refunded` already ran releaseSale
        // (paid→refunded) first, this must not overwrite `refunded` with `failed`.
        await supabase.from('orders').update({ status: 'failed' }).eq('id', orderId).eq('status', 'paid');
        return false;
      }

      if (newSale) {
        try {
          const { data: orderRow, error: orderErr } = await supabase
            .from('orders')
            .select('id, email, total, currency, delivery_method, receiver_first_name, receiver_last_name, inpost_target_point, locale, confirmation_email_sent_at')
            .eq('id', orderId)
            .single();
          if (orderErr) throw new Error(`load order failed for ${orderId}: ${orderErr.message}`);
          const { data: itemRows, error: itemsErr } = await supabase
            .from('order_items')
            .select('product_id, unit_price')
            .eq('order_id', orderId);
          if (itemsErr) throw new Error(`load order_items failed for ${orderId}: ${itemsErr.message}`);
          if (orderRow) {
            const orderRowTyped = orderRow as {
              id: string; email: string | null; total: number; currency: string;
              delivery_method: string; receiver_first_name: string | null;
              receiver_last_name: string | null; inpost_target_point: string | null;
              locale: string | null; confirmation_email_sent_at: string | null;
            };

            const notifyOrder = {
              order: {
                ...orderRowTyped,
                items: (itemRows as Array<{ product_id: string; unit_price: number }> | null) ?? [],
              },
            };
            // Best-effort with bounded retries: fires once (gated on newSale, so
            // retried/duplicate webhook deliveries won't re-notify). A few quick
            // retries survive transient Resend blips; the operational label email
            // (InPost webhook) remains the backstop. Log on final failure — do NOT
            // throw (would skip the customer confirmation below).
            let studioSent = false;
            for (let attempt = 0; attempt < 3 && !studioSent; attempt++) {
              try {
                await emailNewOrderToStudio(notifyOrder);
                studioSent = true;
              } catch (err) {
                if (attempt === 2) {
                  console.error('emailNewOrderToStudio failed for', orderId, err);
                } else {
                  await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
                }
              }
            }

            // confirmation_email_sent_at guards against duplicate sends on Stripe
            // webhook retries — only send if we haven't successfully sent before.
            if (orderRowTyped.email && !orderRowTyped.confirmation_email_sent_at) {
              let confirmSent = false;
              for (let attempt = 0; attempt < 3 && !confirmSent; attempt++) {
                try {
                  await emailOrderConfirmationToCustomer({
                    order: { id: orderId, email: orderRowTyped.email, receiver_first_name: orderRowTyped.receiver_first_name },
                    locale: orderRowTyped.locale ?? 'pl',
                  });
                  confirmSent = true;
                } catch (err) {
                  if (attempt === 2) {
                    console.error('emailOrderConfirmationToCustomer failed for', orderId, err);
                  } else {
                    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
                  }
                }
              }
              if (confirmSent) {
                await supabase
                  .from('orders')
                  .update({ confirmation_email_sent_at: new Date().toISOString() })
                  .eq('id', orderId);
              }
            }

            // Cancel any pending abandoned-checkout recovery for this buyer
            // (cart.purchased → the automation's wait_for_event). Best-effort:
            // awaited like the emails above, but never throws so fulfillment and
            // inventory updates are unaffected.
            try {
              await sendPurchasedEvent({ orderId, email: orderRowTyped.email });
            } catch (err) {
              console.error('sendPurchasedEvent failed for', orderId, err);
            }
          }
        } catch (err) {
          console.error('newSale order processing failed for', orderId, err);
        }
      }

      // Burn the single-use private-sale link now that the order is `paid`. Runs for
      // new sales AND Stripe retries (order already `paid`), and only this far — never
      // on the under-fulfillment path above, which returns early so the link stays
      // usable for a retry. `consumed_at IS NULL` keeps it idempotent; we THROW on a
      // real failure so Stripe replays the webhook until the token is consumed.
      if (privateSaleId) {
        const { error: consumeErr } = await supabase
          .from('private_sales')
          .update({ consumed_at: new Date().toISOString() })
          .eq('id', privateSaleId)
          .is('consumed_at', null);
        if (consumeErr) throw new Error(`private_sales consume failed for ${orderId}: ${consumeErr.message}`);
      }

      return newSale;
    },
    releaseHold: async (pi) => {
      const { data } = await supabase
        .from('orders')
        .update({ status: 'failed' })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id, private_sale_id');
      const rows = data as Array<{ id: string; private_sale_id: string | null }> | null;
      // Retry-safe: on a Stripe re-delivery the order is already `failed`, so the
      // update above matches nothing. Fall back to fetching it (mirrors markPaid's
      // already-processed path) so a release that threw on the first attempt is
      // retried, not silently skipped — otherwise the pieces stay stuck `reserved`.
      const order =
        rows?.[0] ??
        ((
          await supabase
            .from('orders')
            .select('id, private_sale_id')
            .eq('payment_intent_id', pi)
            .eq('status', 'failed')
            .maybeSingle()
        ).data as { id: string; private_sale_id: string | null } | null);
      if (order) {
        // Private-sale pieces return to `sold` (never relisted publicly); normal holds relist.
        await releaseReservedPieces(supabase, order);
      }
    },
    releaseSale: async (pi) => {
      const { data, error: ordersErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'paid')
        .select('id, private_sale_id');
      if (ordersErr) throw new Error(`releaseSale orders update failed: ${ordersErr.message}`);
      const rows = data as Array<{ id: string; private_sale_id: string | null }> | null;
      if (!rows || rows.length === 0) return false;
      // Private-sale pieces were sold privately (already hidden from the shop) and must
      // stay `sold` on refund — skip the relist write entirely. Normal refunds relist.
      if (releaseTargetStatus(rows[0]) === 'sold') return true;
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
        Sentry.captureException(err);
      }
    },
    createShipment: async (pi) => {
      // Determine what line items this order has. Read failures throw so Stripe
      // retries — a transient DB error must never silently skip fulfilment.
      const { data: orderIdRow, error: orderErr } = await supabase
        .from('orders')
        .select('id')
        .eq('payment_intent_id', pi)
        .single();
      const orderId = (orderIdRow as { id: string } | null)?.id;
      if (orderErr || !orderId) {
        throw new Error(`createShipment: order lookup failed for ${pi}: ${orderErr?.message ?? 'not found'}`);
      }
      const { data: lineItems, error: itemsErr } = await supabase
        .from('order_items')
        .select('variant')
        .eq('order_id', orderId);
      if (itemsErr || !lineItems) {
        throw new Error(`createShipment: order_items lookup failed for ${orderId}: ${itemsErr?.message ?? 'not found'}`);
      }
      const hasCeramics = lineItems.some((i) => i.variant === null);
      const hasPrints   = lineItems.some((i) => i.variant !== null);

      // Prodigi fulfilment: prints only. enqueueProdigi throws on failure →
      // Stripe retries (idempotent via the job's idempotency_key).
      if (hasPrints) {
        await enqueueProdigi(orderId, env, ctx);
      }

      // InPost fulfilment: ceramics only — skip for print-only orders.
      if (!hasCeramics) return;

      try {
        await createOrderShipment(pi, {
          loadOrder: async (paymentIntentId) => {
            const { data } = await supabase
              .from('orders')
              .select(
                'id, delivery_method, email, receiver_first_name, receiver_last_name, ' +
                  'receiver_phone, inpost_target_point, shipping_address, inpost_shipment_id, ' +
                  'inpost_dispatch_order_id, delivery_status',
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
