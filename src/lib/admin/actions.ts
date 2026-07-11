/**
 * LOCAL-ONLY admin mutations, extracted from the four `/api/admin/*` route
 * handlers so the same logic is reachable from `scripts/orders-cli.ts` without
 * going through an OpenNext/Workers request. Each function takes already-built
 * clients (Supabase / Stripe / InPost) instead of calling `adminSupabase()` /
 * `adminStripe()` / `getInPost()` itself — the HTTP routes build those from
 * `getCloudflareContext()` as before; the CLI builds them from its own loaded
 * env (see `adminSupabaseFromEnv()` / `adminStripeFromEnv()` / `inpostFromEnv()`).
 *
 * Every function returns a `{ status, body }` pair shaped exactly like the
 * route's previous `NextResponse.json(body, { status })` call, so callers on
 * both sides get the same Polish message strings and HTTP status codes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import type { InPostClient } from '@/lib/inpost';
import { cancelPrintFulfilment } from '@/server/fulfilment/cancel-print';
import { emailOrderConfirmationToCustomer } from '@/lib/email';
import { createOrderShipment } from '@/lib/shipment';
import { ShipxApiError } from '@/lib/shipx-errors';
import { needsShipment, type OrderForShipment } from '@/lib/shipx';
import { countCeramicOrderItems, type CeramicCountClient } from '@/lib/fulfillment';
import { releaseReservedPieces } from '@/lib/piece-release';
import type { CancelOutcome } from '@/lib/expire-orders';
import type { DeliveryMethod } from '@/lib/pricing';

export type ActionResult = { status: number; body: { message: string } | { error: string } };

function ok(message: string): ActionResult {
  return { status: 200, body: { message } };
}
function fail(status: number, error: string): ActionResult {
  return { status, body: { error } };
}

// ── refund ────────────────────────────────────────────────────────────────────

export type RefundDeps = { supabase: SupabaseClient; stripe: Stripe; env: CloudflareEnv };

/**
 * Issue a FULL Stripe refund for a paid order, then stop any Prodigi print
 * fulfilment. Full-refund-only: the `charge.refunded` webhook only relists
 * pieces on a full refund, so a partial refund here would move money without
 * relisting the piece.
 */
export async function refundOrder(deps: RefundDeps, orderId: string): Promise<ActionResult> {
  const { supabase, stripe, env } = deps;
  const { data, error } = await supabase
    .from('orders')
    .select('payment_intent_id, status')
    .eq('id', orderId)
    .maybeSingle();
  if (error) return fail(500, error.message);
  if (!data) return fail(404, 'Order not found');
  if (data.status !== 'paid') {
    return fail(409, `Nie można zwrócić zamówienia o statusie „${data.status}”.`);
  }
  if (!data.payment_intent_id) {
    return fail(409, 'Brak PaymentIntent dla zamówienia.');
  }

  const pi = data.payment_intent_id;
  let refundId: string;
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: pi },
      { idempotencyKey: `admin_refund_${pi}` },
    );
    refundId = refund.id;
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : 'Stripe refund failed');
  }
  // Print orders: stop the Prodigi side immediately — the charge.refunded
  // webhook re-runs this later as the backstop (idempotent, never throws).
  // Deliberately outside the try: once the refund exists, a fulfilment hiccup
  // must not be reported back as a failed refund.
  await cancelPrintFulfilment(orderId, env);
  return ok(`Zwrot utworzony (${refundId}). Status zaktualizuje webhook.`);
}

// ── release reservation ──────────────────────────────────────────────────────

export type ReleaseReservationDeps = { supabase: SupabaseClient; stripe: Stripe };

async function cancelIntent(stripe: Stripe, pi: string): Promise<CancelOutcome> {
  try {
    await stripe.paymentIntents.cancel(pi);
    return 'canceled';
  } catch {
    try {
      const intent = await stripe.paymentIntents.retrieve(pi);
      if (intent.status === 'canceled') return 'canceled';
      if (intent.status === 'succeeded' || intent.status === 'processing' || intent.status === 'requires_capture') {
        return 'paid';
      }
      return 'error';
    } catch {
      return 'error';
    }
  }
}

/**
 * Free pieces stuck in `reserved` for an order (e.g. an abandoned checkout
 * whose hold never expired), relisting them as available. Cancels the
 * PaymentIntent first when the order is still pending — mirrors
 * `expireAbandonedOrders`'s cancel-then-release ordering.
 */
export async function releaseReservation(deps: ReleaseReservationDeps, orderId: string): Promise<ActionResult> {
  const { supabase, stripe } = deps;
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('status, private_sale_id, payment_intent_id')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return fail(500, orderErr.message);
  if (!order) return fail(404, 'Order not found');
  if (order.status === 'paid') {
    return fail(409, 'Zamówienie opłacone — użyj zwrotu, nie zwalniaj rezerwacji.');
  }

  if (order.status === 'pending' && order.payment_intent_id) {
    const outcome = await cancelIntent(stripe, order.payment_intent_id);
    if (outcome === 'paid') {
      return fail(409, 'Płatność w toku lub zakończona — nie można zwolnić rezerwacji.');
    }
    if (outcome === 'error') {
      return fail(502, 'Nie udało się anulować PaymentIntent w Stripe.');
    }
  }

  // Private-sale pieces return to `sold` (never relisted publicly); normal holds relist as available.
  let freed: string[];
  try {
    freed = await releaseReservedPieces(supabase, { id: orderId, private_sale_id: order.private_sale_id });
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : 'Zwolnienie rezerwacji nie powiodło się.');
  }

  const count = freed.length;
  if (count > 0 && order.status === 'pending') {
    const { error: expireErr } = await supabase
      .from('orders')
      .update({ status: 'expired' })
      .eq('id', orderId)
      .eq('status', 'pending');
    if (expireErr) return fail(500, expireErr.message);
  }

  return ok(count ? `Zwolniono ${count} prac(e).` : 'Brak zarezerwowanych prac do zwolnienia.');
}

// ── resend confirmation ───────────────────────────────────────────────────────

export type ResendConfirmationDeps = { supabase: SupabaseClient; env: CloudflareEnv };

/** Re-send the customer order-confirmation email, reusing `emailOrderConfirmationToCustomer`. */
export async function resendOrderConfirmation(
  deps: ResendConfirmationDeps,
  orderId: string,
): Promise<ActionResult> {
  const { supabase, env } = deps;
  const { data, error } = await supabase
    .from('orders')
    .select('id, email, receiver_first_name, locale')
    .eq('id', orderId)
    .maybeSingle();
  if (error) return fail(500, error.message);
  if (!data) return fail(404, 'Order not found');
  if (!data.email) return fail(409, 'Zamówienie nie ma adresu e-mail.');

  try {
    await emailOrderConfirmationToCustomer({
      order: { id: data.id, email: data.email, receiver_first_name: data.receiver_first_name },
      locale: data.locale ?? 'pl',
      env,
    });
    return ok(`Potwierdzenie wysłane ponownie na ${data.email}.`);
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : 'Wysyłka nie powiodła się');
  }
}

// ── create shipment ───────────────────────────────────────────────────────────

export type CreateShipmentDeps = { supabase: SupabaseClient; inpost: InPostClient };

function isDeliveryMethod(method: string | null): method is DeliveryMethod {
  return method === 'paczkomat' || method === 'kurier' || method === 'odbior';
}

function friendlyShipmentError(err: unknown): string {
  if (err instanceof ShipxApiError) {
    if (err.code === 'validation_failed' || err.code === 'offer_expired' || err.code === 'offer_unavailable') {
      return 'Oferta wygasła — użyj „Utwórz nową przesyłkę”.';
    }
    if (err.shipxMessage?.includes('debt_collection') || err.message.includes('debt_collection')) {
      return 'InPost odrzucił zakup (debt_collection) — ureguluj saldo w Managerze Paczek.';
    }
  }
  const msg = err instanceof Error ? err.message : 'ShipX shipment failed';
  if (msg.includes('no buyable offer found')) {
    return 'Brak aktywnej oferty — użyj „Utwórz nową przesyłkę”.';
  }
  return msg;
}

/**
 * Create (or recreate) the InPost shipment for a paid order. Mirrors the
 * Stripe webhook shipment wiring and stays idempotent through
 * `createOrderShipment`'s `inpost_shipment_id` guard.
 */
export async function createShipmentForOrder(
  deps: CreateShipmentDeps,
  orderId: string,
  opts?: { recreate?: boolean },
): Promise<ActionResult> {
  const { supabase, inpost } = deps;
  const recreate = opts?.recreate === true;

  const { data: order, error } = await supabase
    .from('orders')
    .select('payment_intent_id, status, delivery_method, inpost_shipment_id')
    .eq('id', orderId)
    .maybeSingle();

  if (error) return fail(500, error.message);
  if (!order) return fail(404, 'Order not found');
  if (order.status !== 'paid') {
    return fail(409, `Nie można utworzyć przesyłki dla zamówienia o statusie „${order.status}”.`);
  }
  if (!order.payment_intent_id) {
    return fail(409, 'Brak PaymentIntent dla zamówienia.');
  }
  if (!isDeliveryMethod(order.delivery_method)) {
    return fail(409, 'Nieobsługiwana metoda dostawy.');
  }
  if (!needsShipment(order.delivery_method)) {
    return fail(409, 'Odbiór osobisty nie wymaga przesyłki.');
  }

  // Print-only orders (no ceramic line items) are shipped by Prodigi — an
  // InPost shipment for one would be paid for and never used.
  const { count: ceramicCount, error: countErr } = await countCeramicOrderItems(
    supabase as unknown as CeramicCountClient,
    orderId,
  );
  if (countErr) return fail(500, countErr.message);
  if ((ceramicCount ?? 0) === 0) {
    return fail(409, 'Zamówienie zawiera tylko druki — wysyłkę realizuje Prodigi, nie InPost.');
  }

  const hadShipment = !!order.inpost_shipment_id;

  if (recreate) {
    if (!hadShipment) {
      return fail(409, 'Brak przesyłki do zastąpienia.');
    }
    const { error: clearErr } = await supabase
      .from('orders')
      .update({
        inpost_shipment_id: null,
        inpost_tracking_number: null,
        inpost_dispatch_order_id: null,
        delivery_status: null,
        inpost_label_emailed_at: null,
      })
      .eq('id', orderId);
    if (clearErr) return fail(500, clearErr.message);
  }

  try {
    await createOrderShipment(
      order.payment_intent_id,
      {
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
        saveShipment: async (id, d) => {
          const { error: saveErr } = await supabase
            .from('orders')
            .update({
              inpost_shipment_id: d.shipmentId,
              inpost_tracking_number: d.trackingNumber,
              delivery_status: d.status,
            })
            .eq('id', id)
            .is('inpost_shipment_id', null);
          if (saveErr) throw saveErr;
        },
        saveDispatchOrderId: async (id, dispatchOrderId) => {
          const { error: saveErr } = await supabase
            .from('orders')
            .update({ inpost_dispatch_order_id: dispatchOrderId })
            .eq('id', id)
            .is('inpost_dispatch_order_id', null);
          if (saveErr) throw saveErr;
        },
        inpost,
      },
      recreate ? { adoptExisting: false } : undefined,
    );

    if (recreate) return ok('Nowa przesyłka utworzona.');
    return ok(hadShipment ? 'Przesyłka już istnieje.' : 'Przesyłka utworzona.');
  } catch (e) {
    return fail(502, friendlyShipmentError(e));
  }
}
