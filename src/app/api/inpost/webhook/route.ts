import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getInPost } from '@/lib/inpost';
import { emailLabelToStudio, type LabelEmailOrder } from '@/lib/email';
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
  const { data: order } = (await supabase
    .from('orders')
    .select(
      'id, delivery_method, inpost_tracking_number, inpost_target_point, ' +
        'receiver_first_name, receiver_last_name, inpost_label_emailed_at',
    )
    .eq('inpost_shipment_id', evt.shipmentId)
    .single()) as {
    data: {
      id: string;
      delivery_method: string;
      inpost_tracking_number: string | null;
      inpost_target_point: string | null;
      receiver_first_name: string | null;
      receiver_last_name: string | null;
      inpost_label_emailed_at: string | null;
    } | null;
  };

  // Unknown shipment → acknowledge so InPost stops retrying.
  if (!order) return NextResponse.json({ received: true });

  // Mirror the latest status (+ tracking number once it appears).
  await supabase
    .from('orders')
    .update({
      delivery_status: evt.status,
      ...(evt.trackingNumber ? { inpost_tracking_number: evt.trackingNumber } : {}),
    })
    .eq('id', order.id);

  // Label is printable from `confirmed`. Fetch + email exactly once.
  if (evt.status === LABEL_READY_STATUS && !order.inpost_label_emailed_at) {
    // Atomically claim the email slot (NULL→timestamp) so two concurrent
    // `confirmed` deliveries can't both send. Only the row-winning delivery
    // proceeds; on send failure we release the slot for a later retry.
    const claimedAt = new Date().toISOString();
    const { data: claimed } = (await supabase
      .from('orders')
      .update({ inpost_label_emailed_at: claimedAt })
      .eq('id', order.id)
      .is('inpost_label_emailed_at', null)
      .select('id')) as { data: Array<{ id: string }> | null };

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
        // Release the slot (only if still our claim) so InPost's retry re-sends.
        await supabase
          .from('orders')
          .update({ inpost_label_emailed_at: null })
          .eq('id', order.id)
          .eq('inpost_label_emailed_at', claimedAt);
        console.error('label email failed for shipment', evt.shipmentId, err);
      }
    }
  }

  return NextResponse.json({ received: true });
}
