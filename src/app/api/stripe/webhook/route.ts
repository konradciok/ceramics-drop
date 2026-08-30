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
import { emailNewOrderToStudio, emailOrderConfirmationToCustomer, emailRefundFailedAlertToStudio, emailPrivateSaleDoublePaidAlertToStudio, emailDisputeCreatedAlertToStudio, emailInvoiceFailedAlertToStudio } from '@/lib/email';
import { sendPurchasedEvent } from '@/lib/resend-events';
import { isNonRetryableShipxError, shouldRethrowShipmentError } from '@/lib/shipx-errors';
import type { OrderForShipment } from '@/lib/shipx';
import { sendPurchaseConversions, sendRefundConversion, type ConversionOrder } from '@/lib/marketing/conversions';
import type { MarketingContext } from '@/lib/marketing/context';
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
  idColumn?: 'resend_email_id',
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
    // L-7: the route still 200s, so no redelivery will retry this — without an
    // alert the email is silently lost.
    Sentry.captureMessage('email_claim_failed', {
      level: 'error',
      extra: { order_id: orderId, column, error: claimErr.message },
    });
    return;
  }
  if (!claimed || claimed.length === 0) return;

  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      const result = await send();
      sent = true;
      if (idColumn) {
        // Correlate the Resend send with this order (F-13) so an inbound
        // bounce/complaint webhook can name it. Best-effort: the email already
        // sent, so a failed write never rethrows — it alerts for reconciliation.
        const emailId = (result as { id?: string | null } | undefined)?.id ?? null;
        if (emailId) {
          const { error: idErr } = await supabase
            .from('orders')
            .update({ [idColumn]: emailId })
            .eq('id', orderId);
          if (idErr) {
            Sentry.captureMessage('resend_email_id persist failed', {
              level: 'warning',
              extra: { order_id: orderId, email_id: emailId, error: idErr.message },
            });
          }
        }
      }
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
      // L-7: a stuck claim blocks every future retry until a manual column
      // reset — the operator must know which order to reset.
      Sentry.captureMessage('email_claim_release_failed', {
        level: 'error',
        extra: { order_id: orderId, column, error: releaseErr.message },
      });
    }
  }
}

/**
 * M-5: the pending→paid CAS hit `private_sales_one_paid_order` (23505) —
 * another order already holds this private sale's single paid slot, so this
 * captured payment must be refunded and its order parked terminal `failed`
 * (never left `pending`, which the abandoned-checkout cron and other pending
 * flows would act on). Ordering is crash-safe and idempotent:
 *   1. durable `refund_pending_at` marker CAS'd on status='pending' BEFORE any
 *      money moves — while set, pending consumers (cron expiry, admin release)
 *      refuse the order via their `refund_pending_at IS NULL` claim predicate.
 *      A zero-row marker CAS means the order is no longer pending: classify
 *      first, and NEVER refund a row we can't account for.
 *   2. refund under the shared `refund_<pi>` idempotency key. Stripe keys
 *      expire (~24h) inside the 3-day retry window, so a late crash-retry can
 *      see `charge_already_refunded` — that IS success, continue.
 *   3. converge any pieces still reserved to this order (private-sale target
 *      `sold` — a lapsed `reserved` row would leak into public checkout).
 *   4. CAS pending→failed clearing the marker. Zero rows → follow-up lookup:
 *      only a documented safe terminal state (`failed`/`refunded`) acks 200;
 *      anything else throws so Stripe retries.
 * A crash anywhere re-enters through the same 23505 on redelivery; every step
 * is CAS- or key-idempotent.
 */
/**
 * Best-effort promo-redemption release for the unpaid-outcome paths
 * (releaseHold, releaseSale's pending→refunded + already-refunded resume).
 * Never throws: a stuck `pending` redemption only over-counts toward
 * max_redemptions until the cron reconcile sweep converges it, so failing the
 * webhook over it would trade a bounded accounting error for a Stripe retry
 * storm. The RPC is state-aware — a 'redeemed' row is never touched.
 */
async function settlePromoReleased(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  order: { id: string; promo_code?: string | null },
): Promise<void> {
  if (!order.promo_code) return;
  try {
    const { error } = await supabase.rpc('settle_promo_redemption', {
      p_order_id: order.id,
      p_status: 'released',
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error('promo release settle failed for', order.id, err);
    Sentry.captureMessage('promo_release_settle_failed', {
      level: 'warning',
      extra: { order_id: order.id, promo_code: order.promo_code },
    });
  }
}

async function handlePrivateSaleDoublePaid(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  stripe: ReturnType<typeof getStripe>,
  pi: string,
): Promise<void> {
  const classify = async (): Promise<string | null> => {
    const { data, error } = await supabase
      .from('orders')
      .select('id, status, private_sale_id, promo_code')
      .eq('payment_intent_id', pi)
      .maybeSingle();
    if (error) throw new Error(`double-paid classification lookup failed for ${pi}: ${error.message}`);
    return (data as { status: string } | null)?.status ?? null;
  };

  const { data: marked, error: markErr } = (await supabase
    .from('orders')
    .update({ refund_pending_at: new Date().toISOString() })
    .eq('payment_intent_id', pi)
    .eq('status', 'pending')
    .select('id, private_sale_id')) as {
      data: Array<{ id: string; private_sale_id: string | null }> | null;
      error: { message: string } | null;
    };
  if (markErr) throw new Error(`double-paid marker CAS failed for ${pi}: ${markErr.message}`);
  if (!marked || marked.length === 0) {
    const status = await classify();
    // `failed`/`refunded` are the documented safe terminal states — the refund
    // already happened (or is another delivery's responsibility). Anything
    // else (missing, paid, pending…) is unaccountable: throw, never refund.
    if (status === 'failed' || status === 'refunded') return;
    throw new Error(`double-paid order for ${pi} in unexpected state ${status ?? 'missing'}`);
  }
  const orderId = marked[0].id;
  const privateSaleId = marked[0].private_sale_id;

  try {
    await stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `refund_${pi}` });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : null;
    if (code !== 'charge_already_refunded') {
      console.error('double-paid refund failed for', pi, err);
      Sentry.captureException(err);
      throw err;
    }
  }

  // Throws on failure → 5xx → the retry re-enters via the same 23505, the
  // marker CAS re-claims (still pending), the refund no-ops on its key.
  await releaseReservedPieces(supabase, { id: orderId, private_sale_id: privateSaleId });

  // Alert BEFORE the terminal CAS: once the order is `failed`, a redelivery
  // acks through the marker-zero-row branch without re-alerting, so an isolate
  // death between the CAS and a post-CAS alert would silence the refund
  // forever. Pre-CAS, a crash re-enters via the 23505 and re-alerts — the
  // Resend Idempotency-Key dedupes the duplicate email. The email itself stays
  // best-effort (Sentry already captured): a Resend outage must not block the
  // state machine from converging.
  Sentry.captureMessage('private_sale_double_paid', {
    level: 'error',
    extra: { payment_intent_id: pi, order_id: orderId, private_sale_id: privateSaleId },
  });
  try {
    await emailPrivateSaleDoublePaidAlertToStudio({
      orderId,
      paymentIntentId: pi,
      idempotencyKey: `double-paid-alert/${orderId}`,
    });
  } catch (err) {
    console.error('double-paid studio alert email failed for', orderId, err);
    Sentry.captureException(err);
  }

  const { data: failedRows, error: failErr } = (await supabase
    .from('orders')
    .update({ status: 'failed', refund_pending_at: null })
    .eq('payment_intent_id', pi)
    .eq('status', 'pending')
    .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };
  if (failErr) throw new Error(`double-paid pending→failed CAS failed for ${pi}: ${failErr.message}`);
  if (!failedRows || failedRows.length === 0) {
    const status = await classify();
    if (status !== 'failed' && status !== 'refunded') {
      throw new Error(`double-paid order for ${pi} in unexpected state ${status ?? 'missing'} after refund`);
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

  // Idempotency ledger (F-18): claim this Stripe event id once, mirroring the
  // Prodigi lease/CAS in src/server/prodigi/callbacks.ts (~L44-93). Statuses:
  //  - `done`                      → completed delivery, skip.
  //  - `processing` within lease   → a concurrent in-flight delivery owns it,
  //                                   skip (prevents concurrent double-processing).
  //  - `processing` past lease     → stale/abandoned; reclaim with a CAS on the
  //                                   old lease value so only one racer wins.
  // A mid-handler throw leaves the row `processing`; Stripe's retry (minutes–days
  // later, well past the lease) reclaims the stale lease and re-runs the
  // CAS-idempotent steps as no-ops.
  const STRIPE_LEASE_MS = 5 * 60 * 1000;
  const claimedAt = new Date().toISOString();
  // M-22: dedupe-200 is reserved for a `done` row — EVERY claim loser answers
  // 409 so Stripe retries later. A 200 from a losing delivery would suppress
  // the redelivery that rescues the event if the in-flight winner dies mid-
  // handler (isolate death leaves the row `processing` with nobody coming
  // back). Stripe treats any non-2xx as retry-later; concurrent duplicates now
  // show in the dashboard as failed attempts that later succeed — expected,
  // do not "fix" the 409s back to 200.
  const inFlight = () => NextResponse.json({ received: false, inFlight: true }, { status: 409 });
  const { data: seen, error: seenErr } = await supabase
    .from('webhook_events')
    .select('id, status, processing_started_at')
    .eq('provider', 'stripe')
    .eq('provider_event_id', event.id)
    .maybeSingle();
  // M-21: a failed lookup must not fall through to the insert branch — the
  // 23505 there over an existing non-`done` row would read as "duplicate" and
  // return a false dedupe-200, dropping a retryable event.
  if (seenErr) throw new Error(`webhook_events seen lookup failed: ${seenErr.message}`);
  const seenRow = seen as { id: string; status: string; processing_started_at: string | null } | null;

  if (seenRow?.status === 'done') {
    return NextResponse.json({ received: true, deduped: true });
  }
  if (seenRow) {
    // Active (non-stale) processing lease ⇒ another delivery is mid-flight.
    if (seenRow.status === 'processing' && seenRow.processing_started_at) {
      const age = Date.now() - new Date(seenRow.processing_started_at).getTime();
      if (age < STRIPE_LEASE_MS) {
        return inFlight();
      }
    }
    // Reclaim a stale lease with a compare-and-swap on the prior lease value so
    // two racing deliveries can't both win (same shape as callbacks.ts).
    const claimUpdate = supabase
      .from('webhook_events')
      .update({ status: 'processing', processing_started_at: claimedAt })
      .eq('id', seenRow.id)
      .eq('status', seenRow.status);
    const claimCas = seenRow.processing_started_at === null
      ? claimUpdate.is('processing_started_at', null)
      : claimUpdate.eq('processing_started_at', seenRow.processing_started_at);
    const { data: claimed, error: casErr } = await claimCas.select('id').maybeSingle();
    if (casErr) throw new Error(`webhook_events claim failed: ${casErr.message}`);
    if (!claimed) return inFlight();
  } else {
    const { error: insErr } = await supabase.from('webhook_events').insert({
      provider: 'stripe',
      provider_event_id: event.id,
      event_type: event.type,
      raw_json: event as unknown,
      status: 'processing',
      processing_started_at: claimedAt,
    });
    // Unique violation (23505) = a concurrent delivery inserted between our
    // SELECT and INSERT. Re-read: only a row that already reached `done` may
    // dedupe-200 — anything else is in flight (or failed) and must 409.
    if (insErr && (insErr as { code?: string }).code === '23505') {
      const { data: raced, error: racedErr } = await supabase
        .from('webhook_events')
        .select('status')
        .eq('provider', 'stripe')
        .eq('provider_event_id', event.id)
        .maybeSingle();
      if (racedErr) throw new Error(`webhook_events race lookup failed: ${racedErr.message}`);
      if ((raced as { status: string } | null)?.status === 'done') {
        return NextResponse.json({ received: true, deduped: true });
      }
      return inFlight();
    }
    if (insErr) throw new Error(`webhook_events insert failed: ${insErr.message}`);
  }

  // Release the webhook_events lease on any handler throw so Stripe's retry
  // reclaims the event immediately (timing-independent) instead of being deduped
  // as an in-flight `processing` row within STRIPE_LEASE_MS — which would silently
  // drop fulfilment for a retryable failure (e.g. createShipment re-throwing a
  // ShipX error). Mirrors releaseClaim in src/server/prodigi/callbacks.ts.
  // L-4: CAS'd on OUR claim timestamp — a stale releaser whose lease was
  // reclaimed by a newer delivery must not clobber that claimant's state.
  // Best-effort: if the release itself fails, the lease still expires after the TTL.
  const releaseLease = () =>
    supabase
      .from('webhook_events')
      .update({ status: 'failed', processing_started_at: null })
      .eq('provider', 'stripe')
      .eq('provider_event_id', event.id)
      .eq('processing_started_at', claimedAt)
      .then(undefined, (e) => console.error('webhook_events lease release failed', event.id, e));

  await handleStripeEvent(event, {
    markPaid: async (pi) => {
      const { data: orderData, error: orderErr } = (await supabase
        .from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id, private_sale_id, promo_code')) as {
          data: Array<{ id: string; private_sale_id: string | null; promo_code: string | null }> | null;
          error: { message: string; code?: string } | null;
        };

      if (orderErr) {
        // 23505 here can only come from `private_sales_one_paid_order` — the
        // double-paid private sale (M-5). Refund-then-fail instead of a 3-day
        // 5xx loop with captured money and no refund.
        if (orderErr.code === '23505') {
          await handlePrivateSaleDoublePaid(supabase, stripe, pi);
          return false;
        }
        throw new Error(`markPaid orders update failed: ${orderErr.message}`);
      }

      let orderId: string;
      // Fetched up front (not just in the newSale branch) so the single-use token is
      // consumed on Stripe retries too, where the order is already `paid`.
      let privateSaleId: string | null = null;
      let promoCode: string | null = null;
      let newSale = false;
      if (orderData && orderData.length > 0) {
        orderId = orderData[0].id;
        privateSaleId = orderData[0].private_sale_id;
        promoCode = orderData[0].promo_code;
        newSale = true;
      } else {
        const { data: existing, error: existingErr } = await supabase
          .from('orders')
          .select('id, status, private_sale_id, promo_code')
          .eq('payment_intent_id', pi)
          .single() as {
            data: { id: string; status: string; private_sale_id: string | null; promo_code: string | null } | null;
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
        if (existing.status === 'failed' || existing.status === 'expired') {
          // Stripe just confirmed payment for an order we consider dead. After the
          // payment_failed fix in webhook.ts this should be rare — reachable only
          // via a genuine payment_intent.canceled, or the under-fulfilment
          // auto-refund branch below — but money moved, so silence would hide it.
          // `paid` (below) is a normal idempotent retry; `refunded` is releaseSale's
          // documented pending→refunded race (refund observed before success) —
          // neither needs an alert.
          console.error('markPaid: succeeded on a dead order', pi, existing.id, existing.status);
          Sentry.captureMessage('stripe_webhook_succeeded_on_dead_order', {
            level: 'error',
            extra: { payment_intent_id: pi, order_id: existing.id, order_status: existing.status },
          });
        }
        if (existing.status !== 'paid') return false;
        orderId = existing.id;
        privateSaleId = existing.private_sale_id;
        promoCode = existing.promo_code;
      }

      // H-1: an unchecked failure here is asymmetric — the follow-up COUNT
      // still succeeds, reads 0 sold rows, and the under-fulfilment branch
      // below auto-refunds a legitimate payment. Throw → 5xx → Stripe retries.
      const { error: soldErr } = await supabase
        .from('piece_state')
        .update({ status: 'sold', reserved_until: null })
        .eq('order_id', orderId)
        .eq('status', 'reserved');
      if (soldErr) throw new Error(`markPaid piece_state sold update failed: ${soldErr.message}`);

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
          .select('id, email, total, currency, delivery_method, receiver_first_name, receiver_last_name, inpost_target_point, locale, promo_code, discount, confirmation_email_sent_at, studio_email_sent_at')
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
            locale: string | null; promo_code: string | null; discount: number | null;
            confirmation_email_sent_at: string | null;
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
          // M-27: the per-order Idempotency-Key makes the in-claim retries (and
          // a post-release redelivery within Resend's 24 h window) single-send
          // even when a timed-out request was actually accepted. Residual: a
          // redelivery >24 h after an accepted-but-timed-out send can still
          // duplicate — accepted, see the Plan 06 PR / runbook note.
          if (!orderRowTyped.studio_email_sent_at) {
            await sendEmailOnceWithClaim(supabase, orderId, 'studio_email_sent_at', () =>
              emailNewOrderToStudio({ ...notifyOrder, idempotencyKey: `studio-new-order/${orderId}` }),
            );
          }

          // Customer order confirmation — same claim-once semantics.
          if (orderRowTyped.email && !orderRowTyped.confirmation_email_sent_at) {
            await sendEmailOnceWithClaim(supabase, orderId, 'confirmation_email_sent_at', () =>
              emailOrderConfirmationToCustomer({
                order: { id: orderId, email: orderRowTyped.email, receiver_first_name: orderRowTyped.receiver_first_name },
                locale: orderRowTyped.locale ?? 'pl',
                kind: isPrintOnlyOrder ? 'print' : 'ceramic',
                idempotencyKey: `order-confirmation/${orderId}`,
              }),
              'resend_email_id',
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
              // A failed cart.purchased leaves the abandoned-checkout automation armed,
              // so a buyer who just paid can still get a recovery email. Best-effort
              // (route still 200s) — surface it like the other webhook conditions.
              Sentry.captureMessage('stripe_webhook_purchased_event_failed', {
                level: 'error',
                extra: { order_id: orderId, error: err instanceof Error ? err.message : String(err) },
              });
            }
          }
        }
      } catch (err) {
        console.error('order paid post-processing failed for', orderId, err);
        // L-7: this swallow is deliberate (emails/notifications must not block
        // fulfilment), but console-only meant a broken email path was invisible
        // until a customer complained.
        Sentry.captureException(err);
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

      // Settle the promo redemption now the order is paid. Same error contract
      // as the private-sale burn above: an RPC error THROWS so Stripe retries.
      // A `false` settle means the row sits at the other terminal state
      // ('released' — an expiry/release raced the in-flight payment):
      // reconcile by re-claiming (the RPC re-claims released rows for the same
      // order when capacity allows) and settling again. If capacity is gone,
      // alert and continue WITHOUT throwing — retrying can never win back
      // exhausted capacity, and a paid order must not fail over promo
      // accounting.
      if (promoCode) {
        const settleRedeemed = () =>
          supabase.rpc('settle_promo_redemption', { p_order_id: orderId, p_status: 'redeemed' });
        const { data: settled, error: settleErr } = await settleRedeemed();
        if (settleErr) throw new Error(`promo settle failed for ${orderId}: ${settleErr.message}`);
        if (settled !== true) {
          const { data: promoRow, error: promoErr } = await supabase
            .from('promo_codes')
            .select('id')
            .eq('code', promoCode)
            .maybeSingle();
          if (promoErr) throw new Error(`promo settle failed for ${orderId}: promo lookup: ${promoErr.message}`);
          const promoId = (promoRow as { id: string } | null)?.id ?? null;
          let reconciled = false;
          if (promoId) {
            const { data: reclaimed, error: reclaimErr } = await supabase.rpc('claim_promo_redemption', {
              p_promo_id: promoId,
              p_order_id: orderId,
            });
            if (reclaimErr) throw new Error(`promo settle failed for ${orderId}: re-claim: ${reclaimErr.message}`);
            if (reclaimed === true) {
              const { data: resettled, error: resettleErr } = await settleRedeemed();
              if (resettleErr) throw new Error(`promo settle failed for ${orderId}: re-settle: ${resettleErr.message}`);
              reconciled = resettled === true;
            }
          }
          if (!reconciled) {
            console.error('markPaid: promo settle lost capacity for', orderId, promoCode);
            Sentry.captureMessage('promo_settle_lost_capacity', {
              level: 'error',
              extra: { order_id: orderId, promo_code: promoCode, payment_intent_id: pi },
            });
          }
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
        .select('id, private_sale_id, promo_code');
      const rows = data as Array<{ id: string; private_sale_id: string | null; promo_code: string | null }> | null;
      // Retry-safe: on a Stripe re-delivery the order is already `failed`, so the
      // update above matches nothing. Fall back to fetching it (mirrors markPaid's
      // already-processed path) so a release that threw on the first attempt is
      // retried, not silently skipped — otherwise the pieces stay stuck `reserved`.
      const order =
        rows?.[0] ??
        ((
          await supabase
            .from('orders')
            .select('id, private_sale_id, promo_code')
            .eq('payment_intent_id', pi)
            .eq('status', 'failed')
            .maybeSingle()
        ).data as { id: string; private_sale_id: string | null; promo_code: string | null } | null);
      if (order) {
        // Private-sale pieces return to `sold` (never relisted publicly); normal holds relist.
        await releaseReservedPieces(supabase, order);
        await settlePromoReleased(supabase, order);
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
      // Clears the M-5 marker/lease as it goes terminal: a charge.refunded
      // racing the double-paid window (our own refund's event, or a Dashboard
      // refund) must not leave refund_pending_at set forever on a refunded row.
      const { data: pendingData, error: pendingErr } = await supabase
        .from('orders')
        .update({ status: 'refunded', refund_pending_at: null, expiry_claim_at: null })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id, private_sale_id, promo_code');
      if (pendingErr) throw new Error(`releaseSale pending update failed: ${pendingErr.message}`);
      const pendingRows = pendingData as Array<{ id: string; private_sale_id: string | null; promo_code: string | null }> | null;
      if (pendingRows && pendingRows.length > 0) {
        // No Prodigi cancel: fulfilment only enqueues for paid orders, and this
        // order never reached paid. Throws on failure → 5xx → the retry resumes
        // through the already-refunded fallback below.
        const freed = await releaseReservedPieces(supabase, pendingRows[0]);
        // A refund on a never-paid order is not a clawback — the claim settles
        // 'released' like any other unpaid outcome (master non-goal #4).
        await settlePromoReleased(supabase, pendingRows[0]);
        return freed.length > 0;
      }

      const { data, error: ordersErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'paid')
        .select('id, private_sale_id, subtotal, shipping, currency, discount, marketing');
      if (ordersErr) throw new Error(`releaseSale orders update failed: ${ordersErr.message}`);
      const rows = data as Array<{
        id: string;
        private_sale_id: string | null;
        subtotal: number;
        shipping: number;
        currency: string;
        discount: number;
        marketing: MarketingContext | null;
      }> | null;
      if (rows && rows.length > 0) {
        // Print orders: stop the Prodigi side (cancel or alert). Runs only when
        // the paid→refunded CAS actually flipped, so a replayed event can't
        // re-enter. Best-effort — never throws.
        await cancelPrintFulfilment(rows[0].id, env);
        // GA4 revenue correction: this order WAS recorded as purchase revenue
        // (it was 'paid'), so a full refund must reverse it. Same real-transition
        // scoping as cancelPrintFulfilment above — never fires on the
        // pending→refunded or already-refunded branches, since no purchase was
        // ever recorded there.
        // Deferred like the purchase send above: the CAS that decides whether to
        // reverse has already committed, so the outbound GA4 call must not hold
        // the webhook response (or the piece relist below) for up to 8s.
        const ga4Secret = env.GA4_API_SECRET;
        const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
        ctx.waitUntil(
          sendRefundConversion(
            {
              payment_intent_id: pi,
              subtotal: rows[0].subtotal,
              shipping: rows[0].shipping,
              currency: rows[0].currency,
              discount: rows[0].discount,
              marketing: rows[0].marketing,
            },
            { ga4Config: ga4Secret && measurementId ? { measurementId, apiSecret: ga4Secret } : undefined },
          ).catch((err) => console.error('releaseSale deferred refund conversion failed for', pi, err)),
        );
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
        .select('id, private_sale_id, promo_code')
        .eq('payment_intent_id', pi)
        .eq('status', 'refunded')
        .maybeSingle();
      if (refundedErr) throw new Error(`releaseSale refunded lookup failed: ${refundedErr.message}`);
      const refundedOrder = refunded as { id: string; private_sale_id: string | null; promo_code: string | null } | null;
      if (!refundedOrder) return false;
      // Resume-path promo convergence: only a genuinely-stranded 'pending'
      // redemption transitions (the RPC is state-aware — a 'redeemed' row from
      // the paid→refunded path is never touched, per the no-clawback rule).
      await settlePromoReleased(supabase, refundedOrder);
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
        // L-5: invoicing stays best-effort (Stripe must get its 200, there is
        // no retry/backfill machinery) — but the operator must hear about it
        // the day it happens, not at the next manual reconcile. The alert
        // itself is best-effort too: its failure must not 5xx the route.
        try {
          await emailInvoiceFailedAlertToStudio({
            paymentIntentId: pi,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        } catch (alertErr) {
          console.error('invoice-failed alert email failed for', pi, alertErr);
        }
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
    alertRefundFailed: async (refund) => {
      const piId = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id ?? null;
      // Correlate to the order by payment_intent — id only, no customer PII in
      // the alert. Best-effort: a lookup failure still alerts, with order unknown.
      let orderId: string | null = null;
      if (piId) {
        const { data } = await supabase
          .from('orders')
          .select('id')
          .eq('payment_intent_id', piId)
          .maybeSingle();
        orderId = (data as { id: string } | null)?.id ?? null;
      }
      Sentry.captureMessage('stripe_refund_failed', {
        level: 'error',
        extra: {
          payment_intent: piId,
          refund_id: refund.id,
          failure_reason: refund.failure_reason ?? null,
          order_id: orderId,
        },
      });
      // Deliberately allowed to throw: a failed send 5xxes the route, the
      // ledger lease is released, and Stripe's retry re-attempts the alert.
      await emailRefundFailedAlertToStudio({
        orderId,
        refundId: refund.id,
        failureReason: refund.failure_reason ?? null,
      });
    },
    alertDisputeCreated: async (dispute) => {
      const piId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id ?? null;
      // Correlate to the order by payment_intent — id only, no customer PII in
      // the alert. Best-effort: a lookup failure still alerts, with order unknown.
      let orderId: string | null = null;
      if (piId) {
        const { data } = await supabase
          .from('orders')
          .select('id')
          .eq('payment_intent_id', piId)
          .maybeSingle();
        orderId = (data as { id: string } | null)?.id ?? null;
      }
      const evidenceDueBy = dispute.evidence_details?.due_by ?? null;
      Sentry.captureMessage('stripe_dispute_created', {
        level: 'error',
        extra: {
          payment_intent: piId,
          dispute_id: dispute.id,
          reason: dispute.reason ?? null,
          amount: dispute.amount,
          currency: dispute.currency,
          evidence_due_by: evidenceDueBy,
          order_id: orderId,
        },
      });
      // Deliberately allowed to throw: a failed send 5xxes the route, the
      // ledger lease is released, and Stripe's retry re-attempts the alert.
      await emailDisputeCreatedAlertToStudio({
        orderId,
        disputeId: dispute.id,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason ?? null,
        evidenceDueBy,
      });
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

        // Claim before sending: at-least-once webhook delivery means Stripe can
        // redeliver payment_intent.succeeded (e.g. a later step in this same
        // handler throws) well past Meta's ~48h event_id dedup window, which
        // would double-count the conversion. One order = one attempt — deliberately
        // no release-on-failure branch, unlike the email claims above:
        // sendPurchaseConversions never throws (Meta/GA4 failures are its own
        // logged/Sentried best-effort concern), so a release-on-failure branch here
        // would never actually trigger. If a genuine crash between the claim and the
        // send ever strands an order, the recovery is a manual column reset:
        // `UPDATE orders SET conversions_sent_at = NULL WHERE id = '<order-id>'`.
        const { data: claimed, error: claimErr } = await supabase
          .from('orders')
          .update({ conversions_sent_at: new Date().toISOString() })
          .eq('payment_intent_id', pi)
          .is('conversions_sent_at', null)
          .select('id');
        if (claimErr) {
          console.error('conversions_sent_at claim failed for', pi, claimErr);
          // L-7: no redelivery will retry a 200'd route — a silent claim
          // failure drops the server-side conversion with zero trace.
          Sentry.captureMessage('conversions_claim_failed', {
            level: 'error',
            extra: { payment_intent_id: pi, error: claimErr.message },
          });
          return;
        }
        if (!claimed || claimed.length === 0) return;

        // Claim above is synchronous (it's the idempotency guarantee); the send
        // itself is deferred so Stripe gets its 200 without waiting on Meta + GA4
        // (up to ~16s with the 8s timeouts above). sendPurchaseConversions never
        // throws — failures are its own logged/Sentried concern — so the .catch is
        // belt-and-braces against an unhandled rejection escaping into waitUntil.
        ctx.waitUntil(
          sendPurchaseConversions(pi, {
            loadOrder: async (paymentIntentId) => {
              const { data, error } = await supabase
                .from('orders')
                .select(
                  'id, payment_intent_id, status, subtotal, shipping, total, currency, promo_code, discount, email, ' +
                    'receiver_first_name, receiver_last_name, receiver_phone, shipping_address, marketing',
                )
                .eq('payment_intent_id', paymentIntentId)
                .single();
              if (error || !data) {
                // markPaid already ran by this point (trackPurchase fires right after
                // it — see webhook.ts), so the order must exist; any miss here is a
                // transient DB hiccup, not a genuine unknown PI. The old code silently
                // returned null, dropping the server-side conversion with zero trace.
                console.error('conversions loadOrder failed for', paymentIntentId, error);
                Sentry.captureMessage('conversions_load_order_failed', {
                  level: 'warning',
                  extra: { payment_intent_id: paymentIntentId, error: error?.message ?? null },
                });
                return null;
              }
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
          }).catch((err) => console.error('trackPurchase deferred send failed for', pi, err)),
        );
      } catch (err) {
        console.error('trackPurchase failed for', pi, err);
        // L-7: best-effort stays best-effort (never fail the webhook over
        // conversions), but an unexpected throw here must be operator-visible.
        Sentry.captureException(err);
      }
    },
  }).catch(async (err) => {
    await releaseLease();
    throw err;
  });

  // L-4: like releaseLease, scoped to OUR claim — if this delivery exceeded
  // the lease and a newer claimant took over, the write matches nothing and
  // the newer claimant (or a later retry) drives the row to `done`.
  const { error: doneErr } = await supabase
    .from('webhook_events')
    .update({ status: 'done', processed_at: new Date().toISOString() })
    .eq('provider', 'stripe')
    .eq('provider_event_id', event.id)
    .eq('processing_started_at', claimedAt);
  // Fail the request if the completion write errors (F-18): a 200 here would tell
  // Stripe we're done while the ledger row is stuck `processing`. Release the lease
  // and throw so the route 5xxes, Stripe retries, and the retry reclaims immediately
  // and drives the row to `done` — the CAS-idempotent steps re-run as no-ops.
  if (doneErr) {
    await releaseLease();
    throw new Error(`webhook_events done update failed: ${doneErr.message}`);
  }

  return NextResponse.json({ received: true });
}
