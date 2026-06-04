import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getInPost } from '@/lib/inpost';
import { emailLabelToStudio, emailShippingConfirmationToCustomer, type LabelEmailOrder } from '@/lib/email';
import { parseShipxWebhook, LABEL_READY_STATUS } from '@/lib/shipx';

export const dynamic = 'force-dynamic';

/**
 * Inbound InPost ShipX status callback (registered in Manager Paczek as
 * `…/api/inpost/webhook?token=INPOST_WEBHOOK_TOKEN`). On the first time a
 * shipment reaches `confirmed` the label PDF is fetched and emailed to the
 * studio; the `inpost_label_emailed_at` stamp makes that once-only.
 */
export async function POST(req: Request) {
  const { env } = getCloudflareContext();

  // The panel only lets us register a URL, so the shared secret rides in the query.
  const token = new URL(req.url).searchParams.get('token');
  if (!token || token !== env.INPOST_WEBHOOK_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const evt = parseShipxWebhook(raw);
  if (!evt) return NextResponse.json({ error: 'unparseable' }, { status: 400 });

  const supabase = getSupabaseAdmin();

  // Locate the order this shipment belongs to.
  const { data: order, error: lookupErr } = (await supabase
    .from('orders')
    .select(
      'id, delivery_method, inpost_tracking_number, inpost_target_point, ' +
        'receiver_first_name, receiver_last_name, inpost_label_emailed_at, ' +
        'email, locale, customer_notified_at',
    )
    .eq('inpost_shipment_id', evt.shipmentId)
    .maybeSingle()) as {
    data: {
      id: string;
      delivery_method: string;
      inpost_tracking_number: string | null;
      inpost_target_point: string | null;
      receiver_first_name: string | null;
      receiver_last_name: string | null;
      inpost_label_emailed_at: string | null;
      email: string | null;
      locale: string | null;
      customer_notified_at: string | null;
    } | null;
    error: { message: string } | null;
  };

  // A real DB error → 500 so InPost retries (don't lose the status update).
  if (lookupErr) {
    console.error('inpost webhook: order lookup failed', evt.shipmentId, lookupErr);
    return NextResponse.json({ error: 'lookup_failed' }, { status: 500 });
  }
  // Unknown shipment → acknowledge so InPost stops retrying.
  if (!order) return NextResponse.json({ received: true });

  // Mirror the latest status (+ tracking number once it appears).
  const { error: statusErr } = await supabase
    .from('orders')
    .update({
      delivery_status: evt.status,
      ...(evt.trackingNumber ? { inpost_tracking_number: evt.trackingNumber } : {}),
    })
    .eq('id', order.id);
  if (statusErr) {
    console.error('inpost webhook: status update failed', evt.shipmentId, statusErr);
    return NextResponse.json({ error: 'status_update_failed' }, { status: 500 });
  }

  // Label is printable from `confirmed`. Fetch + email exactly once.
  if (evt.status === LABEL_READY_STATUS && !order.inpost_label_emailed_at) {
    // Atomically claim the email slot (NULL→timestamp) so two concurrent
    // `confirmed` deliveries can't both send. Only the row-winning delivery
    // proceeds; on send failure we release the slot for a later retry.
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = (await supabase
      .from('orders')
      .update({ inpost_label_emailed_at: claimedAt })
      .eq('id', order.id)
      .is('inpost_label_emailed_at', null)
      .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };
    // A failed claim must 500 (not silently skip) so InPost redelivers.
    if (claimErr) {
      console.error('inpost webhook: label claim failed', evt.shipmentId, claimErr);
      return NextResponse.json({ error: 'label_claim_failed' }, { status: 500 });
    }

    if (claimed && claimed.length > 0) {
      try {
        const labelPdf = await getInPost().getLabelPdf(evt.shipmentId);
        const emailOrder: LabelEmailOrder = {
          id: order.id,
          delivery_method: order.delivery_method,
          inpost_tracking_number: evt.trackingNumber ?? order.inpost_tracking_number,
          inpost_target_point: order.inpost_target_point,
          receiver_first_name: order.receiver_first_name,
          receiver_last_name: order.receiver_last_name,
        };
        await emailLabelToStudio({ order: emailOrder, labelPdf });
      } catch (err) {
        // Release the slot (only if still our claim) and 500 so InPost redelivers
        // the `confirmed` event and the label send is genuinely retried.
        const { error: releaseErr } = await supabase
          .from('orders')
          .update({ inpost_label_emailed_at: null })
          .eq('id', order.id)
          .eq('inpost_label_emailed_at', claimedAt);
        if (releaseErr) {
          console.error('inpost webhook: label claim release failed', order.id, claimedAt, releaseErr);
        }
        console.error('label email failed for shipment', evt.shipmentId, err);
        return NextResponse.json({ error: 'label_email_failed' }, { status: 500 });
      }
    }
  }

  // Customer shipping-confirmation email — sent once when a shipment is confirmed.
  // Independent of the studio-label block above: a failure here 500s and triggers
  // InPost redelivery without disturbing the already-sent label email.
  //
  // We also require a tracking number to be available before claiming the once-only
  // slot. Tracking is normally assigned at shipment creation, but if `confirmed`
  // arrives before InPost issues it, we defer rather than send a useless
  // trackingless email and permanently burn the slot — a later delivery carrying
  // the tracking number will then send the real notification.
  // We intentionally skip (not 500) when order.email is null: such an order can
  // never be notified, so retrying forever would be wrong.
  const customerTracking = evt.trackingNumber ?? order.inpost_tracking_number;
  if (
    evt.status === LABEL_READY_STATUS &&
    order.email &&
    customerTracking &&
    !order.customer_notified_at
  ) {
    // Atomically claim the customer-notification slot (NULL→timestamp), same
    // pattern as the label slot, so concurrent deliveries can't double-send.
    const notifiedAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = (await supabase
      .from('orders')
      .update({ customer_notified_at: notifiedAt })
      .eq('id', order.id)
      .is('customer_notified_at', null)
      .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };
    if (claimErr) {
      console.error('inpost webhook: customer-notify claim failed', evt.shipmentId, claimErr);
      return NextResponse.json({ error: 'customer_notify_claim_failed' }, { status: 500 });
    }

    if (claimed && claimed.length > 0) {
      try {
        await emailShippingConfirmationToCustomer({
          order: {
            id: order.id,
            email: order.email,
            delivery_method: order.delivery_method,
            receiver_first_name: order.receiver_first_name,
            inpost_tracking_number: customerTracking,
            inpost_target_point: order.inpost_target_point,
          },
          locale: order.locale ?? 'pl',
        });
      } catch (err) {
        // Release the slot (only if still our claim) and 500 so InPost redelivers.
        const { error: releaseErr } = await supabase
          .from('orders')
          .update({ customer_notified_at: null })
          .eq('id', order.id)
          .eq('customer_notified_at', notifiedAt);
        if (releaseErr) {
          console.error('inpost webhook: customer-notify claim release failed', order.id, notifiedAt, releaseErr);
        }
        console.error('customer shipping email failed for shipment', evt.shipmentId, err);
        return NextResponse.json({ error: 'customer_notify_failed' }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ received: true });
}
