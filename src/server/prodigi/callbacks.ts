import { getSupabaseAdmin } from '@/lib/supabase';
import { prodigiClient } from './client';
import { isTerminalStatus, mapProdigiStage } from '../fulfilment/status-map';
import type { CloudflareEnv } from '../../../cloudflare-env';

const LEASE_MINUTES = 5;

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

  // 2. Upsert dedup row — claim processing lease.
  const { data: existing, error: upsertErr } = await supabase
    .from('webhook_events')
    .upsert(
      {
        provider: 'prodigi',
        provider_event_id: event.id,
        event_type: event.type,
        raw_json: body,
        status: 'processing',
        processing_started_at: now,
      },
      { onConflict: 'provider,provider_event_id', ignoreDuplicates: false },
    )
    .select('id, status, processing_started_at')
    .single();

  if (upsertErr) return { status: 500, message: 'DB error on dedup upsert' };

  // Already processed.
  if (existing?.status === 'done') return { status: 200, message: 'Already processed' };

  // In-flight: check lease staleness (> 5 min = reacquire, else skip).
  if (existing?.status === 'processing' && existing.processing_started_at) {
    const age = Date.now() - new Date(existing.processing_started_at).getTime();
    if (age < LEASE_MINUTES * 60 * 1000) return { status: 200, message: 'In flight' };
    // Reacquire stale lease — fall through.
    await supabase.from('webhook_events')
      .update({ processing_started_at: now })
      .eq('id', existing.id);
  }

  // 3. Re-fetch order state from Prodigi (never trust callback payload alone).
  const client = prodigiClient(env);
  let prodigiOrder: Awaited<ReturnType<ReturnType<typeof prodigiClient>['getOrder']>>['order'];
  try {
    const res = await client.getOrder(prodigiOrderId);
    prodigiOrder = res.order;
  } catch {
    return { status: 500, message: 'Failed to re-fetch Prodigi order' };
  }

  const newStage = prodigiOrder.status?.stage ?? 'Unknown';
  const localStatus = mapProdigiStage(newStage);

  // 4. Update prodigi_orders + fulfilment_jobs (guard terminal status).
  const { data: existingPO } = await supabase
    .from('prodigi_orders')
    .select('order_id')
    .eq('prodigi_order_id', prodigiOrderId)
    .single();

  if (existingPO) {
    await supabase.from('prodigi_orders')
      .update({ prodigi_status_stage: newStage, prodigi_raw_json: prodigiOrder, updated_at: now })
      .eq('prodigi_order_id', prodigiOrderId);

    const { data: job } = await supabase
      .from('fulfilment_jobs')
      .select('id, status')
      .eq('order_id', existingPO.order_id)
      .single();

    if (job && !isTerminalStatus(job.status)) {
      await supabase.from('fulfilment_jobs')
        .update({ status: localStatus, updated_at: now })
        .eq('id', job.id);
    }
  }

  // 5. Mark event done.
  await supabase.from('webhook_events')
    .update({ status: 'done', processed_at: now })
    .eq('provider', 'prodigi')
    .eq('provider_event_id', event.id);

  return { status: 200, message: 'OK' };
}
