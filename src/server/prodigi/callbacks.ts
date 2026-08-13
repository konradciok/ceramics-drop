import { getSupabaseAdmin } from '@/lib/supabase';
import { deepRedactSignedUrls } from '@/lib/print-asset-redact';
import { fetchAndMergeProdigiOrder } from './merge';

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
    !('id' in body) || !('type' in body)
  ) {
    rejectLog(body, 'invalid CloudEvents shape');
    return { status: 400, message: 'Invalid CloudEvents shape' };
  }
  const event = body as {
    id: string;
    type: string;
    subject?: unknown;
    data?: Record<string, unknown>;
  };
  const prodigiOrderId = extractProdigiOrderId(event);
  if (!prodigiOrderId) {
    rejectLog(body, 'no Prodigi order id in data.order.id / data.prodigiOrderId / subject');
    return { status: 400, message: 'Missing Prodigi order id' };
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
      // M-14: the callback body echoes items[].assets[].url — a signed URL is a
      // bearer token for its TTL and must not be persisted verbatim.
      raw_json: deepRedactSignedUrls(body),
      status: 'processing',
      processing_started_at: now,
    });
    if (insertErr) {
      // Unique violation = a concurrent delivery claimed it first.
      if (insertErr.code === PG_UNIQUE_VIOLATION) return { status: 200, message: 'In flight' };
      return { status: 500, message: 'DB error on event insert' };
    }
  }

  // 3–5. Re-fetch the order from Prodigi and merge it into prodigi_orders /
  // fulfilment_jobs (+ the claim-once shipping email). Shared verbatim with the
  // M-12 cron reconciliation sweep — see src/server/prodigi/merge.ts. Any merge
  // failure releases the claim so Prodigi's retry can re-run it.
  const merged = await fetchAndMergeProdigiOrder(supabase, env, prodigiOrderId);
  if (!merged.ok) {
    await releaseClaim();
    return { status: 500, message: merged.message };
  }

  // 6. Mark event done.
  await supabase.from('webhook_events')
    .update({ status: 'done', processed_at: now })
    .eq('provider', 'prodigi')
    .eq('provider_event_id', event.id);

  return { status: 200, message: 'OK' };
}

/**
 * F-1: real Prodigi CloudEvents carry the complete order object in `data.order`
 * (id inside) and repeat the order id in `subject` — NOT the `data.prodigiOrderId`
 * the first implementation expected (every real callback 400'd during the Plan 05
 * rehearsal). Accept, in order: `data.order.id` (documented v4 shape), the legacy
 * `data.prodigiOrderId`, then the CloudEvents `subject`.
 */
function extractProdigiOrderId(event: {
  subject?: unknown;
  data?: Record<string, unknown>;
}): string | null {
  const order = event.data?.order as { id?: unknown } | undefined;
  if (typeof order?.id === 'string' && order.id) return order.id;
  const legacy = event.data?.prodigiOrderId;
  if (typeof legacy === 'string' && legacy) return legacy;
  if (typeof event.subject === 'string' && event.subject) return event.subject;
  return null;
}

/**
 * A rejected callback previously left ZERO trace (no ledger row, no log) — the
 * exact failure mode that hid F-1. Log a structured, bounded line so shape
 * drift is visible in Workers Logs; the reconciliation sweep (M-12) is the
 * alerting backstop for orders whose callbacks keep bouncing.
 */
function rejectLog(body: unknown, reason: string): void {
  let snippet: string;
  try {
    snippet = JSON.stringify(body) ?? String(body);
  } catch {
    snippet = String(body);
  }
  if (snippet.length > 300) snippet = snippet.slice(0, 300) + '…';
  console.error(JSON.stringify({ event: 'prodigi_callback_rejected', reason, bodySnippet: snippet }));
}
