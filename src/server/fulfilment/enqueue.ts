import { getSupabaseAdmin } from '@/lib/supabase';
import type { FulfilmentJobMessage } from '../prodigi/types';

const PG_UNIQUE_VIOLATION = '23505';
const ORDER_UNIQUE_CONSTRAINT = 'fulfilment_jobs_order_unique';

/**
 * L-19: strict parser for the env inside a legacy idempotency key (rows from
 * before the persisted `prodigi_env` column). FULL-format match only — a
 * prefix-only regex would accept malformed/future keys and could misclassify
 * an unrelated violation as an env flip.
 */
export function parseEnvFromIdempotencyKey(key: string | null | undefined): string | null {
  const m = /^prodigi:(sandbox|live):order:[^:]+:v1$/.exec(key ?? '');
  return m ? m[1] : null;
}

/**
 * Persist a fulfilment job and enqueue its message. Throws on failure so the
 * Stripe webhook handler rethrows and Stripe retries — a paid order must never
 * silently lose fulfilment (same contract as the InPost shipment path).
 *
 * One deliberate exception (L-19): a unique violation on
 * `fulfilment_jobs_order_unique` where the existing ACTIVE job carries a
 * DIFFERENT PRODIGI_ENV — i.e. the same order re-enqueued after a sandbox↔live
 * flip. That can never converge by retrying (the webhook would 5xx-loop), so
 * the stale-env job is parked as failed_action_required
 * (`env_flip_conflict…` — the cron sweep alerts the studio) and the webhook
 * completes without a queue message. Every OTHER unique violation propagates
 * unchanged.
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
  // A DIFFERENT-key insert for the same order (env flip) is NOT covered by the
  // ON CONFLICT target and surfaces as a fulfilment_jobs_order_unique violation.
  const { data, error } = await supabase
    .from('fulfilment_jobs')
    .upsert(
      {
        id: crypto.randomUUID(),
        order_id: orderId,
        idempotency_key: idempotencyKey,
        status: 'queued',
        prodigi_env: env.PRODIGI_ENV,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();

  if (error) {
    const isOrderUnique =
      error.code === PG_UNIQUE_VIOLATION &&
      `${error.message ?? ''} ${(error as { details?: string }).details ?? ''}`.includes(ORDER_UNIQUE_CONSTRAINT);
    if (isOrderUnique && (await parkEnvFlipConflict(supabase, orderId, env))) {
      return; // classified env flip: parked + alerting path owns it — no 5xx loop.
    }
    throw new Error(`enqueueProdigi: job upsert failed for ${orderId}: ${error.message}`);
  }

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
    // Structured warn so a *production* binding regression (queue unexpectedly
    // unset) is at least visible in Workers Logs instead of silently inlining.
    console.warn(JSON.stringify({ event: 'fulfilment_inline_fallback', orderId, jobId }));
    const { processJob } = await import('./process-job');
    ctx.waitUntil(
      processJob(msg, env, ctx).catch((e) =>
        console.error('[enqueueProdigi] inline processing failed', e),
      ),
    );
  }
}

/**
 * L-19: classify-and-park for the env-flip unique violation. Returns true ONLY
 * when the existing ACTIVE job for this order verifiably carries a different
 * env than the current PRODIGI_ENV (persisted column first, strict key parse
 * for pre-column legacy rows). Anything ambiguous returns false so the caller
 * propagates the original error — never guess an env flip.
 */
async function parkEnvFlipConflict(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  env: CloudflareEnv,
): Promise<boolean> {
  // The partial unique index guarantees at most one active row per order.
  const { data: active, error: selErr } = await supabase
    .from('fulfilment_jobs')
    .select('id, status, prodigi_env, idempotency_key')
    .eq('order_id', orderId)
    .not('status', 'in', '("cancelled","failed_action_required")')
    .maybeSingle();
  if (selErr || !active) return false;

  const row = active as { id: string; status: string; prodigi_env: string | null; idempotency_key: string | null };
  const rowEnv = row.prodigi_env ?? parseEnvFromIdempotencyKey(row.idempotency_key);
  if (!rowEnv || rowEnv === env.PRODIGI_ENV) return false;

  const lastError = `env_flip_conflict: job enqueued under PRODIGI_ENV=${rowEnv}, current env is ${env.PRODIGI_ENV} — resolve manually (the stale-env job will not be retried)`;
  // CAS on the observed status so a job that advanced concurrently isn't clobbered.
  const { data: parked, error: markErr } = await supabase
    .from('fulfilment_jobs')
    .update({ status: 'failed_action_required', last_error: lastError, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', row.status)
    .select('id');
  if (markErr || !parked || parked.length === 0) return false;

  console.error(JSON.stringify({
    event: 'fulfilment_env_flip_conflict',
    orderId,
    jobId: row.id,
    rowEnv,
    currentEnv: env.PRODIGI_ENV,
  }));
  return true;
}
