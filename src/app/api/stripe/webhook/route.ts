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
import { variantKey, PRODIGI_SKU_MAP } from '@/lib/print-cart';
import type { PrintVariantSelection } from '@/lib/types';
import { enqueueProdigi } from '@/server/fulfilment/enqueue';
import { cancelPrintFulfilment } from '@/server/fulfilment/cancel-print';

export const dynamic = 'force-dynamic';

// PostgREST's zero-rows-from-.single() code — "no such row", not a DB failure.
const PGRST_NO_ROWS = 'PGRST116';

/**
 * Claim-then-send-once for an order email guarded by a `*_sent_at` column.
 *
 * Claims atomically (UPDATE … WHERE IS NULL) BEFORE sending, so two
 * overlapping redeliveries can't both pass a stale null-check and both send.
 * The send gets 3 bounded attempts (quick retries survive transient Resend
 * blips); on final failure the claim is released — CAS'd on the exact
 * timestamp we wrote, so only OUR claim is cleared — letting a later
 * redelivery or manual Stripe event replay retry the send. Best-effort:
 * never throws (a lost email must not block fulfillment).
 */
async function sendEmailOnceWithClaim(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  column: 'studio_email_sent_at' | 'confirmation_email_sent_at',
  send: () => Promise<unknown>,
): Promise<void> {
  const claimAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('orders')
    .update({ [column]: claimAt })
    .eq('id', orderId)
    .is(column, null)
    .select('id');
  if (claimErr) {
    console.error(`${column} claim failed for`, orderId, claimErr);
    return;
  }
  if (!claimed || claimed.length === 0) return;

  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      await send();
      sent = true;
    } catch (err) {
      if (attempt === 2) {
        console.error(`${column} email send failed for`, orderId, err);
        // The route still 200s (Stripe won't redeliver a delivered event), so
        // without an alert the released claim waits for a replay nobody knows
        // to perform.
        Sentry.captureException(err);
      } else {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  if (!sent) {
    // If this release itself fails, the claim sticks — logged, and then only
    // a manual column reset re-enables the send.
    const { error: releaseErr } = await supabase
      .from('orders')
      .update({ [column]: null })
      .eq('id', orderId)
      .eq(column, claimAt);
    if (releaseErr) {
      console.error(`${column} claim release failed for`, orderId, releaseErr);
    }
  }
}

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
        // (DB hiccup): throw so the route 5xxes and Stripe retries — returning
        // false would let the later steps (createShipment etc.) run against a
        // payment whose order state is unknown.
        if (existingErr && existingErr.code !== PGRST_NO_ROWS) {
          console.error('markPaid: order lookup failed for payment_intent', pi, existingErr);
          Sentry.captureMessage('stripe_webhook_order_lookup_failed');
          throw new Error(`markPaid: order lookup failed for ${pi}: ${existingErr.message}`);
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
        // The refund MUST exist before pieces are relisted and the order marked
        // failed — swallowing a create failure here would leave a paid customer
        // unrefunded while their pieces go back on sale. Throw → 5xx → Stripe
        // redelivers; everything below is idempotent (refund_ key, status-scoped
        // updates), so the retry resumes exactly here.
        try {
          await stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `refund_${pi}` });
        } catch (err) {
          console.error('refund failed for', pi, err);
          Sentry.captureException(err);
          throw err;
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

      // Runs on EVERY delivery where the order ends up here (fresh CAS or the
      // fallback already-paid retry) — not just `newSale`. Stripe can redeliver
      // payment_intent.succeeded after the pending→paid CAS commits but before
      // this code ran (isolate death); on that redelivery `newSale` is false but
      // confirmation_email_sent_at is still NULL, so the customer must still get
      // their email. Each email's own *_sent_at column is now the only guard.
      try {
        const { data: orderRow, error: loadErr } = await supabase
          .from('orders')
          .select('id, email, total, currency, delivery_method, receiver_first_name, receiver_last_name, inpost_target_point, locale, confirmation_email_sent_at, studio_email_sent_at')
          .eq('id', orderId)
          .single();
        if (loadErr) throw new Error(`load order failed for ${orderId}: ${loadErr.message}`);
        const { data: itemRows, error: itemsErr } = await supabase
          .from('order_items')
          .select('product_id, unit_price, variant')
          .eq('order_id', orderId);
        if (itemsErr) throw new Error(`load order_items failed for ${orderId}: ${itemsErr.message}`);
        if (orderRow) {
          const orderRowTyped = orderRow as {
            id: string; email: string | null; total: number; currency: string;
            delivery_method: string; receiver_first_name: string | null;
            receiver_last_name: string | null; inpost_target_point: string | null;
            locale: string | null; confirmation_email_sent_at: string | null;
            studio_email_sent_at: string | null;
          };

          const items =
            (itemRows as Array<{ product_id: string; unit_price: number; variant: PrintVariantSelection | null }> | null) ?? [];
          const notifyOrder = {
            order: {
              ...orderRowTyped,
              // Print items carry variant + Prodigi SKU so the studio email
              // shows exactly what will be produced; ceramics pass null.
              items: items.map((it) => ({
                product_id: it.product_id,
                unit_price: it.unit_price,
                variant: it.variant
                  ? { ...it.variant, prodigiSku: PRODIGI_SKU_MAP[variantKey(it.variant)]?.sku ?? '—' }
                  : null,
              })),
            },
          };
          const isPrintOnlyOrder = items.length > 0 && items.every((it) => it.variant !== null);

          // Studio notification. Never throws — a lost studio email must not
          // skip the customer confirmation below; the operational label email
          // (InPost webhook) remains the backstop.
          if (!orderRowTyped.studio_email_sent_at) {
            await sendEmailOnceWithClaim(supabase, orderId, 'studio_email_sent_at', () =>
              emailNewOrderToStudio(notifyOrder),
            );
          }

          // Customer order confirmation — same claim-once semantics.
          if (orderRowTyped.email && !orderRowTyped.confirmation_email_sent_at) {
            await sendEmailOnceWithClaim(supabase, orderId, 'confirmation_email_sent_at', () =>
              emailOrderConfirmationToCustomer({
                order: { id: orderId, email: orderRowTyped.email, receiver_first_name: orderRowTyped.receiver_first_name },
                locale: orderRowTyped.locale ?? 'pl',
                kind: isPrintOnlyOrder ? 'print' : 'ceramic',
              }),
            );
          }

          // Cancel any pending abandoned-checkout recovery for this buyer
          // (cart.purchased → the automation's wait_for_event). Unchanged:
          // fresh sales only — a retry redelivery must not re-fire it.
          // Best-effort: awaited like the emails above, but never throws so
          // fulfillment and inventory updates are unaffected.
          if (newSale) {
            try {
              await sendPurchasedEvent({ orderId, email: orderRowTyped.email });
            } catch (err) {
              console.error('sendPurchasedEvent failed for', orderId, err);
            }
          }
        }
      } catch (err) {
        console.error('order paid post-processing failed for', orderId, err);
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
      // Convergence: three CAS attempts, in this order:
      //   1. pending→refunded — refund/lost dispute delivered BEFORE the
      //      succeeded event (e.g. a Dashboard refund during a webhook delivery
      //      delay). Park the order refunded so the late success can never
      //      fulfil it (markPaid's fallback, createShipment, invoicing and
      //      conversions all gate on status), and free the reserved hold.
      //   2. paid→refunded — the normal path.
      //   3. already-refunded — a prior attempt flipped the CAS but crashed
      //      before the piece release stuck; finish it (mirrors releaseHold's
      //      fallback — without this the Stripe retry hits an empty CAS and the
      //      pieces stay 'sold' on a refunded order forever).
      // Checking pending BEFORE paid closes the markPaid race: if markPaid
      // flips pending→paid between our two CAS attempts, the order was pending
      // at attempt 1 — but then attempt 1 would have flipped it first (both are
      // CAS on the same row). A failed/expired order (markPaid's own
      // under-fulfillment refund) matches none of the three and stays a no-op.
      const { data: pendingData, error: pendingErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id, private_sale_id');
      if (pendingErr) throw new Error(`releaseSale pending update failed: ${pendingErr.message}`);
      const pendingRows = pendingData as Array<{ id: string; private_sale_id: string | null }> | null;
      if (pendingRows && pendingRows.length > 0) {
        // No Prodigi cancel: fulfilment only enqueues for paid orders, and this
        // order never reached paid. Throws on failure → 5xx → the retry resumes
        // through the already-refunded fallback below.
        const freed = await releaseReservedPieces(supabase, pendingRows[0]);
        return freed.length > 0;
      }

      const { data, error: ordersErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'paid')
        .select('id, private_sale_id');
      if (ordersErr) throw new Error(`releaseSale orders update failed: ${ordersErr.message}`);
      const rows = data as Array<{ id: string; private_sale_id: string | null }> | null;
      if (rows && rows.length > 0) {
        // Print orders: stop the Prodigi side (cancel or alert). Runs only when
        // the paid→refunded CAS actually flipped, so a replayed event can't
        // re-enter. Best-effort — never throws.
        await cancelPrintFulfilment(rows[0].id, env);
        // Private-sale pieces were sold privately (already hidden from the shop) and must
        // stay `sold` on refund — skip the relist write entirely. Normal refunds relist.
        if (releaseTargetStatus(rows[0]) === 'sold') return true;
        // Throw on a piece_state failure (don't return true): otherwise the caller
        // would revalidate inventory and advertise a piece as available while it is
        // still 'sold' in the DB. A 5xx makes Stripe retry, and the retry finishes
        // the relist through the already-refunded fallback below.
        const { error: pieceErr } = await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', rows[0].id)
          .eq('status', 'sold');
        if (pieceErr) throw new Error(`releaseSale piece_state update failed: ${pieceErr.message}`);
        return true;
      }

      // Already refunded: finish any release a crashed prior attempt left
      // behind — rows still 'sold' (paid-path crash) or 'reserved'
      // (pending-path crash). Scoped by order_id, so pieces since re-sold to
      // another order are never touched.
      const { data: refunded, error: refundedErr } = await supabase
        .from('orders')
        .select('id, private_sale_id')
        .eq('payment_intent_id', pi)
        .eq('status', 'refunded')
        .maybeSingle();
      if (refundedErr) throw new Error(`releaseSale refunded lookup failed: ${refundedErr.message}`);
      const refundedOrder = refunded as { id: string; private_sale_id: string | null } | null;
      if (!refundedOrder) return false;
      // Converge to the order's release target: normal orders relist rows to
      // 'available'; private-sale orders converge only stranded 'reserved'
      // rows to 'sold' — their already-'sold' rows are the correct terminal
      // state and stay untouched, so a routine replay is a no-op. Without the
      // reserved→sold convergence, a private-sale pending-path crash leaves
      // rows 'reserved'; once reserved_until lapses, reserve_pieces() would
      // hand a never-public piece to any public checkout.
      const target = releaseTargetStatus(refundedOrder);
      const { data: freedRows, error: resumeErr } = await supabase
        .from('piece_state')
        .update({ status: target, reserved_until: null, order_id: null })
        .eq('order_id', refundedOrder.id)
        .in('status', target === 'sold' ? ['reserved'] : ['sold', 'reserved'])
        .select('product_id');
      if (resumeErr) throw new Error(`releaseSale resume release failed: ${resumeErr.message}`);
      return ((freedRows as Array<{ product_id: string }> | null) ?? []).length > 0;
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
        .select('id, status')
        .eq('payment_intent_id', pi)
        .single();
      const orderRow = orderIdRow as { id: string; status: string } | null;
      // Zero rows: no order exists for this payment_intent — the unknown-PI
      // case markPaid already alerted on. Retrying can never make the order
      // appear, so return (→ 200) instead of throwing, or Stripe would
      // redeliver this dead event for 3 days.
      if (orderErr?.code === PGRST_NO_ROWS) {
        console.error('createShipment: no order for payment_intent', pi);
        return;
      }
      if (orderErr || !orderRow) {
        throw new Error(`createShipment: order lookup failed for ${pi}: ${orderErr?.message ?? 'not found'}`);
      }
      // Fulfil PAID orders only. markPaid's under-fulfillment path refunds the
      // buyer, relists the pieces, and sets the order `failed` before this
      // runs — buying an InPost label (or enqueueing a Prodigi print) for that
      // order would ship pieces the buyer was just refunded for. Same for a
      // late succeeded-redelivery on an already-refunded order.
      if (orderRow.status !== 'paid') {
        console.error('createShipment: skipping fulfilment for non-paid order', orderRow.id, orderRow.status);
        return;
      }
      const orderId = orderRow.id;
      const { data: lineItems, error: itemsErr } = await supabase
        .from('order_items')
        .select('variant')
        .eq('order_id', orderId);
      if (itemsErr || !lineItems) {
        throw new Error(`createShipment: order_items lookup failed for ${orderId}: ${itemsErr?.message ?? 'not found'}`);
      }
      const hasCeramics = lineItems.some((i) => i.variant === null);
      const hasPrints   = lineItems.some((i) => i.variant !== null);

      // Mixed ceramic+print orders are rejected at checkout (validateCart →
      // mixed_cart) before reservation; this branch is a defensive safety net only.
      if (hasCeramics && hasPrints) {
        console.warn('fulfilment: mixed order — both pipelines will run', { orderId });
        Sentry.captureMessage('fulfilment_mixed_order', {
          level: 'warning',
          extra: { orderId },
        });
      }

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
            const { data, error } = await supabase
              .from('orders')
              .select(
                'id, delivery_method, email, receiver_first_name, receiver_last_name, ' +
                  'receiver_phone, inpost_target_point, shipping_address, inpost_shipment_id, ' +
                  'inpost_dispatch_order_id, delivery_status',
              )
              .eq('payment_intent_id', paymentIntentId)
              .single();
            // A DB failure must throw (→ retry), not read as "no order": a
            // silent null here would skip fulfilment forever with a 200.
            if (error && error.code !== PGRST_NO_ROWS) {
              throw new Error(`createShipment: order load failed for ${paymentIntentId}: ${error.message}`);
            }
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
        const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;
        const appGitSha = process.env.NEXT_PUBLIC_GIT_SHA;

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
          appVersion,
          appGitSha,
        });
      } catch (err) {
        console.error('trackPurchase failed for', pi, err);
      }
    },
  });

  return NextResponse.json({ received: true });
}
