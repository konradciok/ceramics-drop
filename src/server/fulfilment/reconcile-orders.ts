/**
 * M-12: cron reconciliation sweep for stale, non-terminal `prodigi_orders`.
 *
 * A lost callback (transient 500 on our side, or a shape drift like F-1) must
 * not permanently freeze an order's fulfilment status: the customer paid, the
 * order is at Prodigi, but no stage/tracking update would ever land. Every
 * cron tick this sweep re-polls rows whose reconciliation clock is older than
 * RECONCILE_STALE_HOURS, re-running the exact callback merge logic
 * (src/server/prodigi/merge.ts — reuse, not duplication).
 *
 * Clock separation (why `last_reconciled_at` exists): the merge bumps
 * `updated_at` only on meaningful provider progress, and the sweep records
 * every poll in `last_reconciled_at` — so a no-op poll neither hides the row
 * from future sweeps nor spams Prodigi every tick. `stalled_poll_count` counts
 * consecutive no-progress polls; at STALLED_POLL_ALERT_THRESHOLD the
 * `prodigi_order_stalled` alert fires exactly once per stall streak.
 */
import { supabaseFromEnv } from '@/lib/supabase';
import { captureWorkerAlert } from '@/lib/worker-sentry';
import { sendStudioAlertEmail } from '@/lib/studio-alert-email';
import {
  emailDetailTable,
  emailMutedParagraph,
  emailParagraph,
  resendTemplateHtml,
} from '@/lib/email-layout';
import { fetchAndMergeProdigiOrder } from '../prodigi/merge';

export const RECONCILE_STALE_HOURS = 6;
/** Batch cap per cron run — bounds Prodigi calls; the backlog drains next tick. */
export const RECONCILE_BATCH_LIMIT = 10;
/**
 * Consecutive no-progress polls before the stalled alert fires. Progress is
 * measured down to `status.details` sub-statuses (see merge.ts), but a real
 * order can legitimately sit for a day-plus with nothing moving (e.g. shipping
 * booked, carrier pickup pending) — the plan's original threshold of 2
 * (~12–18 h) would have alerted on virtually every normal order given how
 * coarse Prodigi's stages are. 8 polls ≈ 48 h of ZERO movement, which is a
 * genuine anomaly worth a human look.
 */
export const STALLED_POLL_ALERT_THRESHOLD = 8;
/** Prodigi top-level stages that never progress further — the sweep skips them. */
export const PRODIGI_TERMINAL_STAGES = ['Complete', 'Cancelled'] as const;

interface StaleRow {
  id: string;
  order_id: string;
  prodigi_order_id: string;
  prodigi_status_stage: string | null;
  stalled_poll_count: number | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Pure: studio email for a stalled (or vanished) Prodigi order. */
export function buildStalledOrderAlertEmail(input: {
  orderId: string;
  prodigiOrderId: string;
  stage: string | null;
  polls: number;
  missing: boolean;
}): { subject: string; html: string } {
  const subject = input.missing
    ? `[Prodigi] Zamówienie ${input.prodigiOrderId} zniknęło z Prodigi (404)`
    : `[Prodigi] Zamówienie ${input.prodigiOrderId} utknęło (bez postępu od >${RECONCILE_STALE_HOURS * STALLED_POLL_ALERT_THRESHOLD} h)`;
  const html = resendTemplateHtml().replace(
    '{{{MAIN_CONTENT}}}',
    [
      emailParagraph(
        input.missing
          ? '<strong>Prodigi zwraca 404 dla zamówienia, które mamy jako niezakończone.</strong>'
          : '<strong>Zamówienie w Prodigi nie robi postępu mimo kolejnych odpytań (utracone callbacki lub produkcja stoi).</strong>',
      ),
      emailDetailTable([
        { label: 'Zamówienie', value: escapeHtml(input.orderId) },
        { label: 'Prodigi', value: escapeHtml(input.prodigiOrderId) },
        { label: 'Etap', value: escapeHtml(input.stage ?? '—') },
        { label: 'Odpytań bez postępu', value: String(input.polls) },
      ]),
      emailMutedParagraph(
        'Sprawdź dashboard Prodigi i tabelę prodigi_orders / fulfilment_jobs. Sweep odpytuje co ~6 h; alert wysyłany raz na serię zastoju.',
      ),
    ].join(''),
  );
  return { subject, html };
}

export interface ReconcileSweepResult {
  scanned: number;
  progressed: number;
  stalledAlerts: number;
  errors: number;
}

/**
 * One sweep pass. Called from the worker cron; throws only on the initial
 * selection query (the caller alerts a dead sweep) — per-row failures are
 * logged and counted, never abort the batch.
 */
export async function sweepStaleProdigiOrders(env: CloudflareEnv): Promise<ReconcileSweepResult> {
  const supabase = supabaseFromEnv(env);
  const cutoff = new Date(Date.now() - RECONCILE_STALE_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('prodigi_orders')
    .select('id, order_id, prodigi_order_id, prodigi_status_stage, stalled_poll_count')
    .not('prodigi_order_id', 'is', null)
    .not('prodigi_status_stage', 'in', `(${PRODIGI_TERMINAL_STAGES.map((s) => `"${s}"`).join(',')})`)
    // Reconciliation clock: poll when the last poll (or, for never-polled rows,
    // the last meaningful progress) is older than the staleness window.
    .or(`last_reconciled_at.lt.${cutoff},and(last_reconciled_at.is.null,updated_at.lt.${cutoff})`)
    .limit(RECONCILE_BATCH_LIMIT);
  if (error) throw new Error(`sweepStaleProdigiOrders query failed: ${error.message}`);

  const rows = (data ?? []) as StaleRow[];
  const result: ReconcileSweepResult = { scanned: rows.length, progressed: 0, stalledAlerts: 0, errors: 0 };

  for (const row of rows) {
    const merged = await fetchAndMergeProdigiOrder(supabase, env, row.prodigi_order_id);

    if (!merged.ok) {
      if (merged.reason === 'refetch_failed' && merged.status === 404) {
        // The remote order VANISHED — that will never self-heal; alert loudly.
        // last_reconciled_at still advances so the 404 re-alerts at the sweep
        // cadence (bounded), not on every cron tick.
        result.errors++;
        console.error(JSON.stringify({
          event: 'prodigi_reconcile_order_missing',
          orderId: row.order_id,
          prodigiOrderId: row.prodigi_order_id,
        }));
        await captureWorkerAlert(env, {
          message: 'prodigi_reconcile_order_missing',
          level: 'error',
          extra: { orderId: row.order_id, prodigiOrderId: row.prodigi_order_id },
        });
        await sendStudioAlertEmail(
          env,
          buildStalledOrderAlertEmail({
            orderId: row.order_id,
            prodigiOrderId: row.prodigi_order_id,
            stage: row.prodigi_status_stage,
            polls: row.stalled_poll_count ?? 0,
            missing: true,
          }),
          'prodigi order missing (404)',
        ).catch((e) =>
          console.error(JSON.stringify({ event: 'prodigi_reconcile_email_failed', error: String(e) })),
        );
        await markPolled(supabase, row.id, (row.stalled_poll_count ?? 0) + 1);
        continue;
      }
      if (
        merged.reason === 'refetch_failed' &&
        merged.status !== null && merged.status >= 400 && merged.status < 500 && merged.status !== 429
      ) {
        // Permanent-class 4xx (401/403/400…): retrying every 15 min can never
        // succeed and would silently disable the M-12 backstop (e.g. broken
        // API key). Alert and advance the poll clock so re-alerts stay bounded
        // to the sweep cadence.
        result.errors++;
        console.error(JSON.stringify({
          event: 'prodigi_reconcile_refetch_denied',
          orderId: row.order_id,
          prodigiOrderId: row.prodigi_order_id,
          status: merged.status,
        }));
        await captureWorkerAlert(env, {
          message: 'prodigi_reconcile_refetch_denied',
          level: 'error',
          extra: { orderId: row.order_id, prodigiOrderId: row.prodigi_order_id, status: merged.status },
        });
        await markPolled(supabase, row.id, (row.stalled_poll_count ?? 0) + 1);
        continue;
      }
      // Transient (Prodigi 5xx/429/timeout, DB hiccup): log; the next tick
      // retries. Deliberately no last_reconciled_at bump — not a real poll.
      result.errors++;
      console.error(JSON.stringify({
        event: 'prodigi_reconcile_row_error',
        orderId: row.order_id,
        prodigiOrderId: row.prodigi_order_id,
        reason: merged.reason,
        message: merged.message,
      }));
      continue;
    }

    const progressed = merged.progressed;
    const newCount = progressed ? 0 : (row.stalled_poll_count ?? 0) + 1;
    if (progressed) result.progressed++;
    await markPolled(supabase, row.id, newCount);

    // Fire exactly on the threshold transition — later no-progress polls stay
    // quiet, and a progress→stall cycle re-arms the alert.
    if (!progressed && newCount === STALLED_POLL_ALERT_THRESHOLD) {
      result.stalledAlerts++;
      console.error(JSON.stringify({
        event: 'prodigi_order_stalled',
        orderId: row.order_id,
        prodigiOrderId: row.prodigi_order_id,
        stage: merged.newStage,
        polls: newCount,
      }));
      await captureWorkerAlert(env, {
        message: 'prodigi_order_stalled',
        level: 'warning',
        extra: {
          orderId: row.order_id,
          prodigiOrderId: row.prodigi_order_id,
          stage: merged.newStage,
          polls: newCount,
        },
      });
      await sendStudioAlertEmail(
        env,
        buildStalledOrderAlertEmail({
          orderId: row.order_id,
          prodigiOrderId: row.prodigi_order_id,
          stage: merged.newStage,
          polls: newCount,
          missing: false,
        }),
        'stalled prodigi order',
      ).catch((e) =>
        console.error(JSON.stringify({ event: 'prodigi_reconcile_email_failed', error: String(e) })),
      );
    }
  }

  console.log(JSON.stringify({ event: 'prodigi_reconcile_sweep_done', ...result }));
  return result;
}

/** Record the poll on the reconciliation clock (never touches updated_at). */
async function markPolled(
  supabase: ReturnType<typeof supabaseFromEnv>,
  rowId: string,
  stalledPollCount: number,
): Promise<void> {
  const { error } = await supabase
    .from('prodigi_orders')
    .update({ last_reconciled_at: new Date().toISOString(), stalled_poll_count: stalledPollCount })
    .eq('id', rowId);
  if (error) {
    console.error(JSON.stringify({ event: 'prodigi_reconcile_mark_failed', rowId, error: error.message }));
  }
}
