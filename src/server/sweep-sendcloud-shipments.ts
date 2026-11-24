/**
 * Cron backstop for Sendcloud parcel updates (worker.ts, every 15 min).
 * Sendcloud stops retrying a webhook after ~1.5 h, so open Sendcloud parcels
 * are polled and fed through the same handler the webhook uses — which also
 * sends the studio label and customer emails for freshly announced shipments.
 * A no-op (no Sendcloud client is even built) while no order ships through it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendcloudFromEnv, type SendcloudClient } from '@/lib/carriers/sendcloud/client';
import { CANCELED_STATUS, DELIVERED_STATUS, RETURNED_STATUS } from '@/lib/carriers/sendcloud/status-map';
import { sendcloudCarrierFromEnv } from '@/lib/carriers';
import { applySendcloudParcelUpdate } from './sendcloud-parcel-update';

/** Parcels older than this are no longer polled (well past InPost return windows). */
const POLL_WINDOW_DAYS = 45;
const BATCH = 50;

export type SweepSendcloudDeps = {
  supabase: SupabaseClient;
  env: CloudflareEnv;
  /** Injected in tests; built from env on first use otherwise. */
  client?: SendcloudClient;
  getLabelPdf?: (shipmentId: string) => Promise<ArrayBuffer>;
  now?: () => number;
};

export type SweepSendcloudResult = { checked: number; applied: number; failed: Array<{ orderId: string; error: string }> };

export async function sweepSendcloudShipments(deps: SweepSendcloudDeps): Promise<SweepSendcloudResult> {
  const { supabase, env } = deps;
  const since = new Date((deps.now?.() ?? Date.now()) - POLL_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('orders')
    .select('id, inpost_shipment_id')
    .eq('shipping_channel', 'sendcloud')
    .eq('status', 'paid')
    .not('inpost_shipment_id', 'is', null)
    .or(`delivery_status.is.null,delivery_status.not.in.(${DELIVERED_STATUS},${RETURNED_STATUS},${CANCELED_STATUS})`)
    .gte('created_at', since)
    .order('created_at')
    .limit(BATCH);
  if (error) throw new Error(`sendcloud sweep: order load failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; inpost_shipment_id: string }>;
  const result: SweepSendcloudResult = { checked: rows.length, applied: 0, failed: [] };
  if (rows.length === 0) return result;

  const client = deps.client ?? sendcloudFromEnv(env);
  const getLabelPdf =
    deps.getLabelPdf ?? ((id: string) => sendcloudCarrierFromEnv(env, supabase).getLabelPdf(id));

  for (const row of rows) {
    try {
      const shipment = await client.getShipment(row.inpost_shipment_id);
      const parcel = shipment.parcels?.[0];
      if (!parcel?.status) continue;
      const outcome = await applySendcloudParcelUpdate(
        { supabase, getLabelPdf, env },
        {
          orderId: row.id,
          trackingNumber: typeof parcel.tracking_number === 'string' ? parcel.tracking_number : null,
          trackingUrl: typeof parcel.tracking_url === 'string' ? parcel.tracking_url : null,
          status: parcel.status,
        },
      );
      if (outcome === 'applied') result.applied++;
    } catch (err) {
      // One bad row must not starve the rest; the caller alerts on `failed`.
      result.failed.push({ orderId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
