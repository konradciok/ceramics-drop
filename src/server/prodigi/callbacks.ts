import * as Sentry from '@sentry/nextjs';
import { getSupabaseAdmin } from '@/lib/supabase';
import { emailPrintShippingConfirmationToCustomer } from '@/lib/email';
import { httpsUrlOrNull } from '@/lib/tracking';
import { prodigiClient } from './client';
import { isTerminalStatus, mapProdigiStage } from '../fulfilment/status-map';
import type { ProdigiShipment } from './types';

export const LEASE_MINUTES = 5;
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Handle a Prodigi CloudEvents callback.
 *
 * Dedup contract (webhook_events, one row per provider event id):
 *  - 'done'       → replay returns 200 immediately, never reprocessed
 *  - 'processing' → in-flight lease (LEASE_MINUTES); expired leases are taken
 *                   over with a compare-and-swap update, so two concurrent
 *                   deliveries can't both claim the same event
 *  - 'failed'     → a previous attempt errored after claiming; reclaimable
 * Any failure after claiming releases the claim ('failed') before returning
 * 5xx, so Prodigi's retry isn't bounced off our own stale lease.
 */
export async function handleProdigiCallback(
  body: unknown,
  env: CloudflareEnv,
): Promise<{ status: number; message: string }> {
  // 1. Parse CloudEvents shape.
  if (
    typeof body !== 'object' || body === null ||
    !('id' in body) || !('type' in body) || !('data' in body)
  ) {
    return { status: 400, message: 'Invalid CloudEvents shape' };
  }
  const event = body as { id: string; type: string; data: Record<string, unknown> };
  const prodigiOrderId = event.data?.prodigiOrderId as string | undefined;
  if (!prodigiOrderId) {
    return { status: 400, message: 'Missing data.prodigiOrderId' };
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const releaseClaim = async () => {
    await supabase.from('webhook_events')
      .update({ status: 'failed', processing_started_at: null })
      .eq('provider', 'prodigi')
      .eq('provider_event_id', event.id);
  };

  // 2. Claim the event.
  const { data: existing } = await supabase
    .from('webhook_events')
    .select('id, status, processing_started_at')
    .eq('provider', 'prodigi')
    .eq('provider_event_id', event.id)
    .maybeSingle();

  if (existing?.status === 'done') return { status: 200, message: 'Already processed' };

  if (existing) {
    if (existing.status === 'processing' && existing.processing_started_at) {
      const age = Date.now() - new Date(existing.processing_started_at).getTime();
      if (age < LEASE_MINUTES * 60 * 1000) return { status: 200, message: 'In flight' };
    }
    // Take over a stale lease / failed attempt with a CAS on the old lease value,
    // so two racing deliveries can't both win.
    const claimUpdate = supabase
      .from('webhook_events')
      .update({ status: 'processing', processing_started_at: now })
      .eq('id', existing.id)
      .eq('status', existing.status);
    const claimCas = existing.processing_started_at === null
      ? claimUpdate.is('processing_started_at', null)
      : claimUpdate.eq('processing_started_at', existing.processing_started_at);
    const { data: claimed, error: casErr } = await claimCas.select('id').maybeSingle();
    if (casErr) return { status: 500, message: 'DB error on event claim' };
    if (!claimed) return { status: 200, message: 'In flight' };
  } else {
    const { error: insertErr } = await supabase.from('webhook_events').insert({
      provider: 'prodigi',
      provider_event_id: event.id,
      event_type: event.type,
      raw_json: body,
      status: 'processing',
      processing_started_at: now,
    });
    if (insertErr) {
      // Unique violation = a concurrent delivery claimed it first.
      if (insertErr.code === PG_UNIQUE_VIOLATION) return { status: 200, message: 'In flight' };
      return { status: 500, message: 'DB error on event insert' };
    }
  }

  // 3. Re-fetch order state from Prodigi (never trust callback payload alone).
  const client = prodigiClient(env);
  let prodigiOrder: Awaited<ReturnType<ReturnType<typeof prodigiClient>['getOrder']>>['order'];
  try {
    const res = await client.getOrder(prodigiOrderId);
    prodigiOrder = res.order;
  } catch {
    await releaseClaim();
    return { status: 500, message: 'Failed to re-fetch Prodigi order' };
  }

  const newStage = prodigiOrder.status?.stage ?? 'Unknown';
  const localStatus = mapProdigiStage(newStage);

  // 4. Resolve the local order. If the prodigi_orders mapping is missing (callback
  // raced processJob's persist step), fall back to merchantReference — we set it
  // to the internal order id at submission.
  const { data: existingPO, error: poErr } = await supabase
    .from('prodigi_orders')
    .select('order_id')
    .eq('prodigi_order_id', prodigiOrderId)
    .maybeSingle();
  if (poErr) {
    await releaseClaim();
    return { status: 500, message: 'DB error on prodigi_orders lookup' };
  }

  let orderId = existingPO?.order_id as string | undefined;
  if (!orderId && prodigiOrder.merchantReference) {
    const { data: orderRow } = await supabase
      .from('orders')
      .select('id')
      .eq('id', prodigiOrder.merchantReference)
      .maybeSingle();
    orderId = (orderRow as { id: string } | null)?.id;
  }
  if (!orderId) {
    // Can't attribute the callback yet — release and let Prodigi retry.
    await releaseClaim();
    return { status: 500, message: `No local order for Prodigi order ${prodigiOrderId}` };
  }

  // Primary shipment (v1: one persisted tracking per order): first with a
  // tracking number, else first in array order — the same shipment the shipping
  // email cites. The complete shipments[] array stays losslessly in
  // prodigi_raw_json. Because the order state is re-fetched on every callback,
  // late-arriving tracking numbers upgrade these columns automatically.
  const shipments = prodigiOrder.shipments ?? [];
  const shipment = shipments.find((s) => s?.tracking?.number) ?? shipments[0];

  const { error: upErr } = await supabase.from('prodigi_orders').upsert(
    {
      order_id: orderId,
      prodigi_order_id: prodigiOrderId,
      prodigi_status_stage: newStage,
      prodigi_raw_json: prodigiOrder,
      updated_at: now,
      carrier: shipment?.carrier?.name ?? null,
      tracking_number: shipment?.tracking?.number ?? null,
      // Untrusted external URL — persist only absolute https:// values.
      tracking_url: httpsUrlOrNull(shipment?.tracking?.url),
      // Purely Prodigi's dispatchDate — NEVER now(): a replayed/late callback
      // must not shift the ship date to callback-processing time. An absent or
      // unparsable date stays NULL (the UI shows status without a date).
      shipped_at: parseShippedAt(shipment?.dispatchDate),
    },
    { onConflict: 'prodigi_order_id' },
  );
  if (upErr) {
    await releaseClaim();
    return { status: 500, message: 'DB error on prodigi_orders upsert' };
  }

  // 5. Update the order's current (latest) fulfilment job — history may hold
  // cancelled/failed rows, so never assume a single row per order.
  const { data: job } = await supabase
    .from('fulfilment_jobs')
    .select('id, status')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (job && localStatus !== null && !isTerminalStatus(job.status)) {
    const { error: jobErr } = await supabase.from('fulfilment_jobs')
      .update({ status: localStatus, updated_at: now })
      .eq('id', job.id);
    if (jobErr) {
      await releaseClaim();
      return { status: 500, message: 'DB error on fulfilment_jobs update' };
    }
  }

  // 5b. Shipped → email the customer their tracking, exactly once (reusing the
  // same primary shipment the columns above persisted).
  if (localStatus === 'shipped') {
    await sendPrintShippingEmailOnce(supabase, prodigiOrderId, orderId, shipment);
  }

  // 6. Mark event done.
  await supabase.from('webhook_events')
    .update({ status: 'done', processed_at: now })
    .eq('provider', 'prodigi')
    .eq('provider_event_id', event.id);

  return { status: 200, message: 'OK' };
}

/** Prodigi dispatchDate → ISO timestamp, or null when absent/unparsable. */
function parseShippedAt(dispatchDate: string | undefined): string | null {
  if (!dispatchDate) return null;
  const t = Date.parse(dispatchDate);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Claim-then-send-once for the print shipping-confirmation email, guarded by
 * `prodigi_orders.shipping_email_sent_at` (same pattern as the order-email
 * claims in the Stripe webhook). Best-effort: never throws — on a send failure
 * the claim is released (CAS on our own timestamp) so a replayed callback can
 * retry; the callback itself still completes.
 */
async function sendPrintShippingEmailOnce(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  prodigiOrderId: string,
  orderId: string,
  shipment: ProdigiShipment | undefined,
): Promise<void> {
  const { data: order } = await supabase
    .from('orders')
    .select('id, email, receiver_first_name, locale')
    .eq('id', orderId)
    .single();
  const orderRow = order as {
    id: string; email: string | null; receiver_first_name: string | null; locale: string | null;
  } | null;
  if (!orderRow?.email) return; // nothing to send — never claim

  const claimAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('prodigi_orders')
    .update({ shipping_email_sent_at: claimAt })
    .eq('prodigi_order_id', prodigiOrderId)
    .is('shipping_email_sent_at', null)
    .select('order_id');
  if (claimErr) {
    console.error('print shipping email claim failed for', orderId, claimErr);
    return;
  }
  if (!claimed || claimed.length === 0) return; // already sent (or in flight)

  const sendParams = {
    order: orderRow,
    tracking: {
      number: shipment?.tracking?.number ?? null,
      // Same https-only rule as persistence — the URL lands in an email href.
      url: httpsUrlOrNull(shipment?.tracking?.url),
      carrier: shipment?.carrier?.name ?? null,
    },
    locale: orderRow.locale ?? 'pl',
  };

  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      await emailPrintShippingConfirmationToCustomer(sendParams);
      sent = true;
    } catch (err) {
      if (attempt === 2) {
        console.error('print shipping email send failed for', orderId, err);
        // Callback still 200s and Prodigi won't redeliver the same event id —
        // alert so someone can reconcile or replay manually.
        Sentry.captureException(err);
      } else {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  if (!sent) {
    const { error: releaseErr } = await supabase
      .from('prodigi_orders')
      .update({ shipping_email_sent_at: null })
      .eq('prodigi_order_id', prodigiOrderId)
      .eq('shipping_email_sent_at', claimAt);
    if (releaseErr) {
      console.error('print shipping email claim release failed for', orderId, releaseErr);
    }
  }
}
