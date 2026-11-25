/**
 * Apply one Sendcloud parcel status change to its order — shared by the signed
 * webhook (src/app/api/sendcloud/webhook) and the cron backstop
 * (src/server/sweep-sendcloud-shipments.ts), which must behave identically.
 *
 * - The update must belong to the order's CURRENT shipment: the sweep passes
 *   the shipment it read, a webhook its parcel id (checked against the
 *   shipment's parcels). Anything else is a superseded shipment (an admin
 *   recreate) and is ignored. Every write is also fenced on
 *   `inpost_shipment_id`, so a recreate racing this handler cannot receive the
 *   old parcel's data.
 * - The status only moves forward (webhooks arrive out of order; a poll can
 *   race one), and the write is a compare-and-set on the status that was read,
 *   retried on a lost race — see shouldAdvanceStatus.
 * - Label to the studio and the customer shipping email go out exactly once,
 *   through the same NULL→timestamp claims the ShipX webhook uses. A failed
 *   send releases its claim and throws, so the webhook 5xx's (Sendcloud
 *   retries) and the sweep retries next run; if the release itself fails the
 *   error says so, and both callers alert, because that claim now needs a
 *   person to clear it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { LABEL_READY_STATUS } from '@/lib/carriers/status';
import { isLabelReadyOrLater, mapSendcloudStatus, shouldAdvanceStatus } from '@/lib/carriers/sendcloud/status-map';
import type { SendcloudParcelUpdate } from '@/lib/carriers/sendcloud/webhook';
import type { SendcloudShipment } from '@/lib/carriers/sendcloud/client';
import type { DeliveryPoint } from '@/lib/carriers/types';
import { emailLabelToStudio, emailShippingConfirmationToCustomer } from '@/lib/email';
import { httpsUrlOrNull } from '@/lib/tracking';

export type SendcloudUpdateDeps = {
  supabase: SupabaseClient;
  /** A6 label for a Sendcloud shipment id (the adapter's getLabelPdf). */
  getLabelPdf: (shipmentId: string) => Promise<ArrayBuffer>;
  /** Reads a shipment — used to check that a webhook's parcel belongs to it. */
  getShipment: (shipmentId: string) => Promise<SendcloudShipment>;
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

type ClaimColumn = 'inpost_label_emailed_at' | 'customer_notified_at';

const ORDER_COLUMNS =
  'id, shipping_channel, inpost_shipment_id, inpost_tracking_number, inpost_target_point, ' +
  'delivery_point, tracking_url, delivery_status, delivery_method, receiver_first_name, ' +
  'receiver_last_name, email, locale, inpost_label_emailed_at, customer_notified_at';

/** Lost status compare-and-set races tolerated before giving up (the next event retries). */
const MAX_WRITE_ATTEMPTS = 3;

/** The point label shown in emails: the carrier's point code, else its name. */
function pointLabel(order: OrderRow): string | null {
  return order.delivery_point?.code ?? order.delivery_point?.name ?? order.inpost_target_point ?? null;
}

async function loadOrder(supabase: SupabaseClient, orderId: string): Promise<OrderRow | null> {
  const { data, error } = (await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle()) as { data: OrderRow | null; error: { message: string } | null };
  if (error) throw new Error(`sendcloud update: order load failed for ${orderId}: ${error.message}`);
  return data;
}

/** Claim a once-only email slot for the current shipment; true when this caller won it. */
async function claim(supabase: SupabaseClient, order: OrderRow, column: ClaimColumn, at: string): Promise<boolean> {
  const { data, error } = (await supabase
    .from('orders')
    .update({ [column]: at })
    .eq('id', order.id)
    .eq('inpost_shipment_id', order.inpost_shipment_id!)
    .is(column, null)
    .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };
  if (error) throw new Error(`sendcloud update: ${column} claim failed for ${order.id}: ${error.message}`);
  return !!data && data.length > 0;
}

/**
 * Send under a claim; on failure release it (if still ours) and rethrow. A
 * release that fails leaves the slot taken forever — surface that explicitly.
 */
async function sendClaimed(
  supabase: SupabaseClient,
  order: OrderRow,
  column: ClaimColumn,
  send: () => Promise<void>,
): Promise<void> {
  const at = new Date().toISOString();
  if (!(await claim(supabase, order, column, at))) return;
  try {
    await send();
  } catch (err) {
    const { error: releaseErr } = await supabase
      .from('orders')
      .update({ [column]: null })
      .eq('id', order.id)
      .eq(column, at);
    if (releaseErr) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `sendcloud update: ${column} claim stuck for order ${order.id} after a failed send (${reason}); ` +
          `release failed (${releaseErr.message}) — clear orders.${column} to let it retry`,
        { cause: err },
      );
    }
    throw err;
  }
}

export async function applySendcloudParcelUpdate(
  deps: SendcloudUpdateDeps,
  update: SendcloudParcelUpdate,
): Promise<SendcloudUpdateOutcome> {
  const { supabase } = deps;
  const ownership = new Map<string, boolean>();

  /** Whether the update describes this shipment (memoised per shipment id). */
  async function belongsTo(shipmentId: string): Promise<boolean> {
    if (update.shipmentId) return update.shipmentId === shipmentId;
    if (!update.parcelId) return false;
    if (!ownership.has(shipmentId)) {
      const shipment = await deps.getShipment(shipmentId);
      ownership.set(shipmentId, (shipment.parcels ?? []).some((p) => String(p.id) === update.parcelId));
    }
    return ownership.get(shipmentId)!;
  }

  const mapped = mapSendcloudStatus(update.status);
  if (!mapped) {
    console.warn(JSON.stringify({ event: 'sendcloud_unknown_status', order_id: update.orderId, status: update.status }));
  }

  let order: OrderRow | null = null;
  let applied = false;
  let status: string | null = null;
  let trackingNumber: string | null = null;
  let trackingUrl: string | null = null;

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    order = await loadOrder(supabase, update.orderId);
    if (!order || order.shipping_channel !== 'sendcloud' || !order.inpost_shipment_id) return 'not_sendcloud_order';
    if (!(await belongsTo(order.inpost_shipment_id))) return 'superseded_shipment';

    const nextStatus = mapped && shouldAdvanceStatus(order.delivery_status, mapped) ? mapped : null;
    trackingNumber = order.inpost_tracking_number ?? update.trackingNumber;
    trackingUrl = httpsUrlOrNull(update.trackingUrl) ?? order.tracking_url;

    const patch: Record<string, string> = {};
    if (nextStatus) patch.delivery_status = nextStatus;
    if (!order.inpost_tracking_number && trackingNumber) patch.inpost_tracking_number = trackingNumber;
    if (trackingUrl && trackingUrl !== order.tracking_url) patch.tracking_url = trackingUrl;
    if (Object.keys(patch).length === 0) {
      status = order.delivery_status;
      break;
    }

    // Compare-and-set on what was read: the same shipment and the same status.
    let write = supabase
      .from('orders')
      .update(patch)
      .eq('id', order.id)
      .eq('inpost_shipment_id', order.inpost_shipment_id);
    write = order.delivery_status === null ? write.is('delivery_status', null) : write.eq('delivery_status', order.delivery_status);
    const { data, error } = (await write.select('id')) as {
      data: Array<{ id: string }> | null;
      error: { message: string } | null;
    };
    if (error) throw new Error(`sendcloud update: status update failed for ${order.id}: ${error.message}`);
    if (data && data.length > 0) {
      applied = true;
      status = nextStatus ?? order.delivery_status;
      break;
    }
    // Lost the race (a concurrent webhook/sweep or a recreate) — re-read and retry.
    if (attempt === MAX_WRITE_ATTEMPTS - 1) return 'unchanged';
  }
  if (!order) return 'not_sendcloud_order';
  const current = order;

  // Studio label — only while the parcel still waits to be handed over.
  if (status === LABEL_READY_STATUS && !current.inpost_label_emailed_at) {
    await sendClaimed(supabase, current, 'inpost_label_emailed_at', async () => {
      const labelPdf = await deps.getLabelPdf(current.inpost_shipment_id!);
      await emailLabelToStudio({
        order: {
          id: current.id,
          delivery_method: current.delivery_method,
          inpost_tracking_number: trackingNumber,
          inpost_target_point: pointLabel(current),
          receiver_first_name: current.receiver_first_name,
          receiver_last_name: current.receiver_last_name,
        },
        labelPdf,
        env: deps.env,
      });
    });
  }

  // Customer shipping confirmation — once a label exists and a tracking number
  // is known. No email address means it can never be sent: skip, don't retry.
  if (isLabelReadyOrLater(status) && current.email && trackingNumber && !current.customer_notified_at) {
    const email = current.email;
    await sendClaimed(supabase, current, 'customer_notified_at', () =>
      emailShippingConfirmationToCustomer({
        order: {
          id: current.id,
          email,
          delivery_method: current.delivery_method,
          receiver_first_name: current.receiver_first_name,
          inpost_tracking_number: trackingNumber,
          inpost_target_point: pointLabel(current),
          delivery_point: current.delivery_point,
          tracking_url: trackingUrl,
        },
        locale: current.locale ?? 'pl',
        env: deps.env,
      }),
    );
  }

  return applied ? 'applied' : 'unchanged';
}
