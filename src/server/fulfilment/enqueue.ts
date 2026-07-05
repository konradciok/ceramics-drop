import { getSupabaseAdmin } from '@/lib/supabase';
import type { FulfilmentJobMessage } from '../prodigi/types';

/**
 * Persist a fulfilment job and enqueue its message. Throws on failure so the
 * Stripe webhook handler rethrows and Stripe retries — a paid order must never
 * silently lose fulfilment (same contract as the InPost shipment path).
 */
export async function enqueueProdigi(
  orderId: string,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const idempotencyKey = `prodigi:${env.PRODIGI_ENV}:order:${orderId}:v1`;

  // Upsert is idempotent: duplicate webhook → same unique idempotency_key → no
  // second row (ignoreDuplicates returns zero rows on conflict, hence maybeSingle).
  const { data, error } = await supabase
    .from('fulfilment_jobs')
    .upsert(
      { id: crypto.randomUUID(), order_id: orderId, idempotency_key: idempotencyKey, status: 'queued' },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`enqueueProdigi: job upsert failed for ${orderId}: ${error.message}`);

  let jobId = data?.id;
  if (!jobId) {
    // Conflict path (webhook retry): recover the existing job id so a retry can
    // still send the queue message a previous attempt may have failed to send.
    const { data: existing, error: selErr } = await supabase
      .from('fulfilment_jobs')
      .select('id')
      .eq('idempotency_key', idempotencyKey)
      .single();
    if (selErr || !existing) {
      throw new Error(`enqueueProdigi: job row missing after conflict for ${orderId}: ${selErr?.message ?? 'not found'}`);
    }
    jobId = existing.id;
  }

  const msg: FulfilmentJobMessage = { orderId, jobId };

  if (env.FULFILMENT_QUEUE) {
    await env.FULFILMENT_QUEUE.send(msg); // throws → Stripe retry
  } else {
    // Local dev without wrangler: run inline, never throw from webhook handler.
    const { processJob } = await import('./process-job');
    ctx.waitUntil(
      processJob(msg, env, ctx).catch((e) =>
        console.error('[enqueueProdigi] inline processing failed', e),
      ),
    );
  }
}
