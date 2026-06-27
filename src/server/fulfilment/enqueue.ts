import { getSupabaseAdmin } from '@/lib/supabase';
import type { FulfilmentJobMessage } from '../prodigi/types';

export async function enqueueProdigi(
  orderId: string,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const jobId = crypto.randomUUID();
  const idempotencyKey = `prodigi:${env.PRODIGI_ENV}:order:${orderId}:v1`;

  // Upsert is idempotent: duplicate webhook → same unique idempotency_key → no second row.
  const { data, error } = await supabase
    .from('fulfilment_jobs')
    .upsert(
      { id: jobId, order_id: orderId, idempotency_key: idempotencyKey, status: 'queued' },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .single();

  if (error) {
    console.error('[enqueueProdigi] DB error:', error.message);
    return;
  }

  const msg: FulfilmentJobMessage = { orderId, jobId: data?.id ?? jobId };

  if (env.FULFILMENT_QUEUE) {
    await env.FULFILMENT_QUEUE.send(msg);
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
