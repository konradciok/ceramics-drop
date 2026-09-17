import { getSupabaseAdmin } from '@/lib/supabase';
import { captureWorkerAlert } from '@/lib/worker-sentry';
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
  opts?: { client?: ReturnType<typeof getSupabaseAdmin>; livemode?: boolean },
): Promise<void> {
  const supabase = opts?.client ?? getSupabaseAdmin();

  // 2026-09-02 incident (order 63445e00): a real Stripe payment's fulfilment
  // job was submitted to Prodigi SANDBOX because PRODIGI_ENV was misconfigured
  // in production. Sandbox fully simulates the happy path (fake tracking,
  // no errors), so nothing alerted. When the caller supplies the Stripe
  // event's livemode, catch that class of misconfiguration before it can
  // silently recur — never guess when it's omitted (e.g. balance-only orders
  // routed through complete-paid-order.ts have no Stripe mode to compare).
  if (opts?.livemode !== undefined) {
    if (await parkLivemodeMismatch(supabase, orderId, env, opts.livemode)) {
      return; // misconfigured order parked as a failed_action_required audit row
    }
  }

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
        // Ground truth for `orders -- prodigi-env-check`: persisting it here
        // means the audit never needs to retrieve this order's PaymentIntent
        // from Stripe (which only works if the CLI's key happens to match
        // this payment's mode). NULL when the caller has no Stripe mode to
        // compare (opts.livemode omitted — see the guard above).
        livemode: opts?.livemode ?? null,
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

  // A job that already reached a delivered state must NOT be rewritten: parking
  // it would erase real history AND free the per-order unique slot, letting a
  // later enqueue create a duplicate submission. Alert and stop instead — a
  // human decides what a cross-env re-enqueue of a delivered order means.
  if (row.status === 'shipped' || row.status === 'completed') {
    console.error(JSON.stringify({
      event: 'fulfilment_env_flip_conflict',
      orderId,
      jobId: row.id,
      rowEnv,
      currentEnv: env.PRODIGI_ENV,
      note: `existing job already ${row.status}; left untouched`,
    }));
    await captureWorkerAlert(env, {
      message: 'fulfilment_env_flip_conflict_delivered_job',
      level: 'error',
      extra: { orderId, jobId: row.id, rowEnv, currentEnv: env.PRODIGI_ENV, status: row.status },
    });
    return true;
  }

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

/** Pre-submission states process-job.ts can still claim and submit to Prodigi (mirrors its own `.in('status', [...])` claim predicate). */
const CLAIMABLE_JOB_STATUSES = ['queued', 'failed_retryable', 'fulfilment_submitting'];

/**
 * Guards the 2026-09-02 incident class (order 63445e00): a Stripe payment's
 * `event.livemode` disagreeing with the CURRENT `env.PRODIGI_ENV` at the
 * moment of the ORIGINAL enqueue — as opposed to `parkEnvFlipConflict`, which
 * only catches an order being RE-enqueued under a different env than it was
 * first enqueued under. Runs before the normal upsert so a misconfigured
 * order never gets a queued/sandbox-bound job row — only a
 * `failed_action_required` audit row, picked up by the existing 15-min
 * `sweepFailedActionJobs` cron (worker.ts), which alerts the studio.
 *
 * PRODIGI_ENV must be exactly 'live' or 'sandbox' — any other value
 * (unset, a typo like 'production') is itself treated as invalid rather than
 * silently bucketed as "sandbox-equivalent", which would let a TEST payment
 * sail through undetected under a broken/unset env.
 *
 * Uses the same idempotency_key as the normal path. A conflict there means
 * ANOTHER call site (e.g. complete-paid-order.ts's mode-less balance/gift-
 * card path) already created a row under this key — already-parked and
 * delivered/terminal rows are left alone (never rewritten, never re-alerted),
 * but a still-claimable row (queued/failed_retryable/fulfilment_submitting)
 * is CAS-transitioned to failed_action_required so process-job.ts can never
 * pick it up and submit it to the wrong Prodigi environment.
 */
async function parkLivemodeMismatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  env: CloudflareEnv,
  livemode: boolean,
): Promise<boolean> {
  const expectedEnv = livemode ? 'live' : 'sandbox';
  const invalidEnv = env.PRODIGI_ENV !== 'live' && env.PRODIGI_ENV !== 'sandbox';
  if (!invalidEnv && env.PRODIGI_ENV === expectedEnv) return false; // matches — proceed normally

  const idempotencyKey = `prodigi:${env.PRODIGI_ENV}:order:${orderId}:v1`;
  const lastError = invalidEnv
    ? `livemode_mismatch: invalid PRODIGI_ENV=${JSON.stringify(env.PRODIGI_ENV)} — expected 'live' for LIVE Stripe payments or 'sandbox' for TEST Stripe payments; resolve manually`
    : livemode
      ? `livemode_mismatch: a LIVE Stripe payment enqueued fulfilment under PRODIGI_ENV=${env.PRODIGI_ENV} — real order would ship from sandbox; fix PRODIGI_ENV and resolve manually`
      : `livemode_mismatch: a TEST Stripe payment enqueued fulfilment under PRODIGI_ENV=live — would burn real Prodigi production credits; resolve manually`;

  const alert = (jobId: string | null) =>
    captureWorkerAlert(env, {
      message: 'fulfilment_livemode_mismatch',
      level: 'error',
      extra: { orderId, jobId, livemode, prodigiEnv: env.PRODIGI_ENV },
    });
  const log = (jobId: string | null, note?: string) =>
    console.error(JSON.stringify({ event: 'fulfilment_livemode_mismatch', orderId, jobId, livemode, prodigiEnv: env.PRODIGI_ENV, note }));

  const { data: inserted, error: insertErr } = await supabase
    .from('fulfilment_jobs')
    .upsert(
      {
        id: crypto.randomUUID(),
        order_id: orderId,
        idempotency_key: idempotencyKey,
        status: 'failed_action_required',
        prodigi_env: env.PRODIGI_ENV,
        livemode,
        last_error: lastError,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  if (insertErr) {
    throw new Error(`parkLivemodeMismatch: park upsert failed for ${orderId}: ${insertErr.message}`);
  }
  if (inserted?.id) {
    // Brand-new row — first park for this order+env, alert once.
    log(inserted.id);
    await alert(inserted.id);
    return true;
  }

  // Conflict: a row already exists under this idempotency_key, created by
  // another call site. Find it and decide what to do based on its status —
  // never guess, never blindly treat "a row exists" as "already handled".
  const { data: existing, error: selErr } = await supabase
    .from('fulfilment_jobs')
    .select('id, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (selErr || !existing) {
    throw new Error(`parkLivemodeMismatch: existing job lookup failed for ${orderId}: ${selErr?.message ?? 'not found'}`);
  }
  const row = existing as { id: string; status: string };

  if (row.status === 'failed_action_required') return true; // already parked — no-op, no re-alert

  if (!CLAIMABLE_JOB_STATUSES.includes(row.status)) {
    // Already past submission (fulfilment_submitted/shipped/completed/
    // cancelled) — rewriting would erase real history. Alert only.
    log(row.id, `existing job already ${row.status}; left untouched`);
    await alert(row.id);
    return true;
  }

  // Still claimable by process-job.ts — CAS it out of the queue before that
  // can happen. Losing the CAS race means it advanced concurrently; treat as
  // handled by whichever path won, no throw, no duplicate alert.
  const { data: parked, error: markErr } = await supabase
    .from('fulfilment_jobs')
    .update({ status: 'failed_action_required', prodigi_env: env.PRODIGI_ENV, livemode, last_error: lastError, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', row.status)
    .select('id');
  if (markErr) throw new Error(`parkLivemodeMismatch: park update failed for ${orderId}: ${markErr.message}`);
  if (!parked || parked.length === 0) return true;

  log(row.id);
  await alert(row.id);
  return true;
}
