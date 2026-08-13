import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emailPrintShippingConfirmationToCustomer } from '@/lib/email';
import { deepRedactSignedUrls } from '@/lib/print-asset-redact';
import { httpsUrlOrNull } from '@/lib/tracking';
import { prodigiClient, ProdigiError } from './client';
import { isTerminalStatus, mapProdigiStage } from '../fulfilment/status-map';
import type { ProdigiShipment } from './types';

/**
 * The re-fetch-and-merge core shared by the Prodigi callback handler and the
 * M-12 cron reconciliation sweep (a lost callback must not freeze an order —
 * the sweep re-runs exactly this logic on stale rows instead of duplicating it).
 *
 * Semantics preserved from the original callback implementation:
 *  - the order state is ALWAYS re-fetched from Prodigi (callback payloads are
 *    never trusted alone);
 *  - the prodigi_orders upsert merges tracking monotonically per field — fresh
 *    data wins only where present;
 *  - `updated_at` is bumped ONLY on meaningful provider progress (stage change
 *    or a tracking-field change). This keeps the sweep's reconciliation clock
 *    (`last_reconciled_at`) separate: a no-op poll must not look like progress.
 *  - the latest non-terminal fulfilment job is advanced to the mapped status;
 *  - a `shipped` result triggers the claim-once customer shipping email.
 */
export type MergeResult =
  | { ok: true; orderId: string; newStage: string; localStatus: string | null; progressed: boolean }
  | { ok: false; reason: 'refetch_failed' | 'no_local_order' | 'db_error'; message: string; status: number | null };

export async function fetchAndMergeProdigiOrder(
  supabase: SupabaseClient,
  env: CloudflareEnv,
  prodigiOrderId: string,
): Promise<MergeResult> {
  // 1. Re-fetch order state from Prodigi (never trust callback payload alone).
  const client = prodigiClient(env);
  let prodigiOrder: Awaited<ReturnType<ReturnType<typeof prodigiClient>['getOrder']>>['order'];
  try {
    const res = await client.getOrder(prodigiOrderId);
    prodigiOrder = res.order;
  } catch (e) {
    return {
      ok: false,
      reason: 'refetch_failed',
      message: 'Failed to re-fetch Prodigi order',
      status: e instanceof ProdigiError ? e.status : null,
    };
  }

  const newStage = prodigiOrder.status?.stage ?? 'Unknown';
  const localStatus = mapProdigiStage(newStage);

  // 2. Resolve the local order. If the prodigi_orders mapping is missing (callback
  // raced processJob's persist step), fall back to merchantReference — we set it
  // to the internal order id at submission. The persisted tracking columns ride
  // along for the monotonic merge below.
  const { data: existingData, error: poErr } = await supabase
    .from('prodigi_orders')
    .select('order_id, prodigi_status_stage, prodigi_raw_json, carrier, tracking_number, tracking_url, shipped_at')
    .eq('prodigi_order_id', prodigiOrderId)
    .maybeSingle();
  if (poErr) {
    return { ok: false, reason: 'db_error', message: 'DB error on prodigi_orders lookup', status: null };
  }
  const existingPO = existingData as {
    order_id: string | null;
    prodigi_status_stage: string | null;
    prodigi_raw_json: { status?: { details?: unknown } } | null;
    carrier: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    shipped_at: string | null;
  } | null;

  let orderId = existingPO?.order_id ?? undefined;
  if (!orderId && prodigiOrder.merchantReference) {
    const { data: orderRow } = await supabase
      .from('orders')
      .select('id')
      .eq('id', prodigiOrder.merchantReference)
      .maybeSingle();
    orderId = (orderRow as { id: string } | null)?.id;
  }
  if (!orderId) {
    return {
      ok: false,
      reason: 'no_local_order',
      message: `No local order for Prodigi order ${prodigiOrderId}`,
      status: null,
    };
  }

  // Primary shipment (v1: one persisted tracking per order): first with a
  // tracking number, else first in array order — the same shipment the shipping
  // email cites. The complete shipments[] array stays losslessly in
  // prodigi_raw_json. Because the order state is re-fetched on every merge,
  // late-arriving tracking numbers upgrade these columns automatically.
  const shipments = prodigiOrder.shipments ?? [];
  const shipment = shipments.find((s) => s?.tracking?.number) ?? shipments[0];

  // Monotonic per-field merge: a later merge whose re-fetched order is sparse
  // (no shipments, or a shipment missing a field) must never erase previously
  // persisted tracking — fresh data wins only where present.
  const merged = {
    carrier: shipment?.carrier?.name ?? existingPO?.carrier ?? null,
    tracking_number: shipment?.tracking?.number ?? existingPO?.tracking_number ?? null,
    // Untrusted external URL — persist only absolute https:// values (the
    // stored fallback was validated at its own write; re-gated for safety).
    tracking_url: httpsUrlOrNull(shipment?.tracking?.url) ?? httpsUrlOrNull(existingPO?.tracking_url),
    // Purely Prodigi's dispatchDate — NEVER now(): a replayed/late callback
    // must not shift the ship date to callback-processing time. An absent or
    // unparsable date keeps the stored value, else stays NULL.
    shipped_at: parseShippedAt(shipment?.dispatchDate) ?? existingPO?.shipped_at ?? null,
  };

  // Meaningful provider progress = stage change, any tracking-field change, or
  // a `status.details` sub-status change (the top-level stage is coarse —
  // §6.11 — so during days-long production only `details` moves). Only that
  // bumps updated_at (see module doc — the M-12 clock separation).
  // shipped_at compares as a TIME VALUE: Postgres echoes timestamptz as
  // `+00:00` while parseShippedAt emits `…Z`, so string equality would call
  // every poll of a dispatched order "progress" and never let it stall.
  const timeEquals = (a: string | null, b: string | null) =>
    a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));
  const detailsChanged =
    JSON.stringify(prodigiOrder.status?.details ?? null) !==
    JSON.stringify(existingPO?.prodigi_raw_json?.status?.details ?? null);
  const progressed =
    !existingPO ||
    newStage !== (existingPO.prodigi_status_stage ?? null) ||
    detailsChanged ||
    merged.carrier !== (existingPO.carrier ?? null) ||
    merged.tracking_number !== (existingPO.tracking_number ?? null) ||
    merged.tracking_url !== (httpsUrlOrNull(existingPO.tracking_url) ?? null) ||
    !timeEquals(merged.shipped_at, existingPO.shipped_at ?? null);

  // 3. Advance the order's current (latest) fulfilment job FIRST — history may
  // hold cancelled/failed rows, so never assume a single row per order. Doing
  // the job before the prodigi_orders upsert means a crash between the two
  // leaves the STAGE stale (row stays sweep-selectable and converges next
  // poll) instead of the job stale under a terminal stage (which nothing would
  // ever revisit).
  const { data: job } = await supabase
    .from('fulfilment_jobs')
    .select('id, status')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (job && localStatus !== null && !isTerminalStatus(job.status)) {
    const { error: jobErr } = await supabase.from('fulfilment_jobs')
      .update({ status: localStatus, updated_at: new Date().toISOString() })
      .eq('id', job.id);
    if (jobErr) {
      return { ok: false, reason: 'db_error', message: 'DB error on fulfilment_jobs update', status: null };
    }
  }

  const { error: upErr } = await supabase.from('prodigi_orders').upsert(
    {
      order_id: orderId,
      prodigi_order_id: prodigiOrderId,
      prodigi_status_stage: newStage,
      // M-14: the re-fetched order echoes the signed asset URLs — redact before persisting.
      prodigi_raw_json: deepRedactSignedUrls(prodigiOrder),
      ...merged,
      ...(progressed ? { updated_at: new Date().toISOString() } : {}),
    },
    { onConflict: 'prodigi_order_id' },
  );
  if (upErr) {
    return { ok: false, reason: 'db_error', message: 'DB error on prodigi_orders upsert', status: null };
  }

  // 4. Shipped → email the customer their tracking, exactly once (reusing the
  // same primary shipment the columns above persisted). `env` rides along so
  // the sender works from the cron sweep too (no request ALS there).
  if (localStatus === 'shipped') {
    await sendPrintShippingEmailOnce(supabase, env, prodigiOrderId, orderId, shipment);
  }

  return { ok: true, orderId, newStage, localStatus, progressed };
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
 * retry; the merge itself still completes.
 */
async function sendPrintShippingEmailOnce(
  supabase: SupabaseClient,
  env: CloudflareEnv,
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
    env, // cron-context safe: the sender must not resolve getCloudflareContext()
  };

  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      await emailPrintShippingConfirmationToCustomer(sendParams);
      sent = true;
    } catch (err) {
      if (attempt === 2) {
        console.error('print shipping email send failed for', orderId, err);
        // Merge still completes and Prodigi won't redeliver the same event id —
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
