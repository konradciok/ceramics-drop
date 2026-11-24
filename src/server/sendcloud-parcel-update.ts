/**
 * Apply one Sendcloud parcel status change to its order — shared by the signed
 * webhook (src/app/api/sendcloud/webhook) and the cron backstop
 * (src/server/sweep-sendcloud-shipments.ts), which must behave identically.
 *
 * - The status only moves forward (webhooks arrive out of order; a poll can
 *   race one) — see shouldAdvanceStatus.
 * - A change for a parcel whose tracking number differs from the order's is a
 *   superseded shipment (an admin recreate) and is ignored.
 * - Label to the studio and the customer shipping email go out exactly once,
 *   through the same NULL→timestamp claims the ShipX webhook uses; a send
 *   failure releases its claim and throws, so the webhook 5xx's (Sendcloud
 *   retries) and the sweep alerts and retries on its next run.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { LABEL_READY_STATUS } from '@/lib/carriers/status';
import { isLabelReadyOrLater, mapSendcloudStatus, shouldAdvanceStatus } from '@/lib/carriers/sendcloud/status-map';
import type { SendcloudParcelUpdate } from '@/lib/carriers/sendcloud/webhook';
import type { DeliveryPoint } from '@/lib/carriers/types';
import { emailLabelToStudio, emailShippingConfirmationToCustomer } from '@/lib/email';
import { httpsUrlOrNull } from '@/lib/tracking';

export type SendcloudUpdateDeps = {
  supabase: SupabaseClient;
  /** A6 label for a Sendcloud shipment id (the adapter's getLabelPdf). */
  getLabelPdf: (shipmentId: string) => Promise<ArrayBuffer>;
  /** Explicit env for the emails when there is no request context (cron). */
  env?: CloudflareEnv;
};

export type SendcloudUpdateOutcome =
  | 'applied'
  | 'unchanged'
  | 'not_sendcloud_order'
  | 'superseded_shipment';

type OrderRow = {
  id: string;
  shipping_channel: string | null;
  inpost_shipment_id: string | null;
  inpost_tracking_number: string | null;
  inpost_target_point: string | null;
  delivery_point: DeliveryPoint | null;
  tracking_url: string | null;
  delivery_status: string | null;
  delivery_method: string;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  email: string | null;
  locale: string | null;
  inpost_label_emailed_at: string | null;
  customer_notified_at: string | null;
};

const ORDER_COLUMNS =
  'id, shipping_channel, inpost_shipment_id, inpost_tracking_number, inpost_target_point, ' +
  'delivery_point, tracking_url, delivery_status, delivery_method, receiver_first_name, ' +
  'receiver_last_name, email, locale, inpost_label_emailed_at, customer_notified_at';

/** The point label shown in emails: the carrier's point code, else its name. */
function pointLabel(order: OrderRow): string | null {
  return order.delivery_point?.code ?? order.delivery_point?.name ?? order.inpost_target_point ?? null;
}

/** Claim a once-only email slot; true when this caller won it. */
async function claim(
  supabase: SupabaseClient,
  orderId: string,
  column: 'inpost_label_emailed_at' | 'customer_notified_at',
  at: string,
): Promise<boolean> {
  const { data, error } = (await supabase
    .from('orders')
    .update({ [column]: at })
    .eq('id', orderId)
    .is(column, null)
    .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };
  if (error) throw new Error(`sendcloud update: ${column} claim failed for ${orderId}: ${error.message}`);
  return !!data && data.length > 0;
}

/** Release a claim we still hold, after a failed send. */
async function release(
  supabase: SupabaseClient,
  orderId: string,
  column: 'inpost_label_emailed_at' | 'customer_notified_at',
  at: string,
): Promise<void> {
  const { error } = await supabase.from('orders').update({ [column]: null }).eq('id', orderId).eq(column, at);
  if (error) console.error(`sendcloud update: ${column} claim release failed`, orderId, at, error);
}

export async function applySendcloudParcelUpdate(
  deps: SendcloudUpdateDeps,
  update: SendcloudParcelUpdate,
): Promise<SendcloudUpdateOutcome> {
  const { supabase } = deps;
  const { data, error } = (await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', update.orderId)
    .maybeSingle()) as { data: OrderRow | null; error: { message: string } | null };
  if (error) throw new Error(`sendcloud update: order load failed for ${update.orderId}: ${error.message}`);
  if (!data || data.shipping_channel !== 'sendcloud' || !data.inpost_shipment_id) return 'not_sendcloud_order';
  const order = data;

  if (order.inpost_tracking_number && update.trackingNumber && order.inpost_tracking_number !== update.trackingNumber) {
    return 'superseded_shipment';
  }

  const mapped = mapSendcloudStatus(update.status);
  if (!mapped) {
    console.warn(JSON.stringify({ event: 'sendcloud_unknown_status', order_id: order.id, status: update.status }));
  }
  const nextStatus = mapped && shouldAdvanceStatus(order.delivery_status, mapped) ? mapped : null;
  const trackingNumber = order.inpost_tracking_number ?? update.trackingNumber;
  const trackingUrl = httpsUrlOrNull(update.trackingUrl) ?? order.tracking_url;

  const patch: Record<string, string> = {};
  if (nextStatus) patch.delivery_status = nextStatus;
  if (!order.inpost_tracking_number && trackingNumber) patch.inpost_tracking_number = trackingNumber;
  if (trackingUrl && trackingUrl !== order.tracking_url) patch.tracking_url = trackingUrl;
  if (Object.keys(patch).length > 0) {
    const { error: updateErr } = await supabase.from('orders').update(patch).eq('id', order.id);
    if (updateErr) throw new Error(`sendcloud update: status update failed for ${order.id}: ${updateErr.message}`);
  }
  const status = nextStatus ?? order.delivery_status;

  // Studio label — only while the parcel still waits to be handed over.
  if (status === LABEL_READY_STATUS && !order.inpost_label_emailed_at) {
    const at = new Date().toISOString();
    if (await claim(supabase, order.id, 'inpost_label_emailed_at', at)) {
      try {
        const labelPdf = await deps.getLabelPdf(order.inpost_shipment_id!);
        await emailLabelToStudio({
          order: {
            id: order.id,
            delivery_method: order.delivery_method,
            inpost_tracking_number: trackingNumber,
            inpost_target_point: pointLabel(order),
            receiver_first_name: order.receiver_first_name,
            receiver_last_name: order.receiver_last_name,
          },
          labelPdf,
          env: deps.env,
        });
      } catch (err) {
        await release(supabase, order.id, 'inpost_label_emailed_at', at);
        throw err;
      }
    }
  }

  // Customer shipping confirmation — once a label exists and a tracking number
  // is known. No email address means it can never be sent: skip, don't retry.
  if (isLabelReadyOrLater(status) && order.email && trackingNumber && !order.customer_notified_at) {
    const at = new Date().toISOString();
    if (await claim(supabase, order.id, 'customer_notified_at', at)) {
      try {
        await emailShippingConfirmationToCustomer({
          order: {
            id: order.id,
            email: order.email,
            delivery_method: order.delivery_method,
            receiver_first_name: order.receiver_first_name,
            inpost_tracking_number: trackingNumber,
            inpost_target_point: pointLabel(order),
            tracking_url: trackingUrl,
          },
          locale: order.locale ?? 'pl',
          env: deps.env,
        });
      } catch (err) {
        await release(supabase, order.id, 'customer_notified_at', at);
        throw err;
      }
    }
  }

  return Object.keys(patch).length > 0 ? 'applied' : 'unchanged';
}
