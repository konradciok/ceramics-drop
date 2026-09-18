/**
 * Cron-driven recovery path for `print_asset_jobs` rows that are alive in the
 * database but have nothing driving them forward.
 *
 * The failure this exists for (CodeRabbit, PR #318, enqueue.ts:100):
 * `enqueueAssetJob` upserts the job row (status `queued`) and only THEN awaits
 * `sendAssetJobMessage`. A send failure after the row is written leaves that
 * row permanently `queued` with no queue message in flight — no consumer will
 * ever claim it, no DLQ alert will ever fire for it, and a client that does not
 * retry POST /v1/jobs leaves it stranded forever.
 *
 * Shape: the SAME sweep + once-only alert + existing manual re-dispatch that
 * this codebase already uses for the identical problem on the OTHER queue
 * (worker.ts's `sweepStrandedJobs` over `fulfilment_jobs`, and
 * src/server/fulfilment/stranded-job-alert.ts). Deliberately NOT an
 * auto-redispatch/outbox: both recovery levers already exist and are already
 * tested —
 *   - a `queued` job is re-dispatched by re-POSTing /v1/jobs for the same
 *     assetId (jobs-create.ts → enqueueAssetJob is idempotent per upload: it
 *     recovers the SAME row on idempotency-key conflict and re-sends its
 *     message), and
 *   - a `failed_retryable` job is re-dispatched by POST /v1/jobs/{id}/retry
 *     (jobs-retry.ts).
 * An automatic resend from cron would have to reproduce both of those paths'
 * CAS/idempotency guarantees for a failure class that is, by construction, a
 * broken queue binding or a Cloudflare Queues outage — i.e. exactly the
 * condition under which a blind cron resend also fails. Alert the human who can
 * see WHY it failed; give them a button that already works.
 *
 * Structure note: unlike the fulfilment sibling (a pure builder, with the query
 * living in worker.ts), this module owns the whole sweep — same shape as
 * src/server/fulfilment/reconcile-orders.ts's `sweepStaleProdigiOrders`. That
 * is what makes the cutoff predicate and the once-only `stranded_alerted_at`
 * guard unit-testable at all; worker.ts has no test file. The pure builder is
 * still exported separately so the email/Sentry payload is testable without I/O.
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

/**
 * The non-terminal statuses this watchdog treats as "stranded" when old.
 *
 * `processing` is deliberately EXCLUDED: a row stuck mid-processing is a lost
 * lease, a different failure mode owned by the claim/lease logic in
 * process-job.ts — not a job that never got dispatched. `completed` /
 * `failed_action_required` are terminal, and the latter already alerts
 * synchronously at the moment of transition (process-job.ts's `failJob`), so
 * re-alerting it here would be duplicate noise.
 */
export const STRANDED_ASSET_JOB_STATUSES = ['queued', 'failed_retryable'] as const;

/**
 * Age (on `created_at`) past which a still-undispatched job is stranded.
 *
 * 4h, not the fulfilment sweep's 2h — a deliberate, load-bearing difference.
 * wrangler.jsonc gives `print-asset-jobs` max_retries 10, and worker.ts retries
 * with `Math.min(2 ** attempts * 30, 3600)` seconds of backoff; the full
 * schedule (60s, 120s, 240s, 480s, 960s, 1920s, then 3600s repeating) spans
 * ≈4h before the message is exhausted into the DLQ. A 2h cutoff would therefore
 * alert on every job that is still legitimately retrying and is about to get a
 * DLQ alert of its own anyway. 4h means "the queue has had its entire retry
 * budget and this row still never progressed".
 */
export const STRANDED_ASSET_JOB_AFTER_MS = 4 * 60 * 60 * 1000;

/** Batch cap per cron run — bounds the email/Sentry payload; backlog drains next tick. */
export const STRANDED_ASSET_JOB_BATCH_LIMIT = 100;

/** Max chars of `last_error` retained in log/Sentry/email (keeps events small). */
const LAST_ERROR_MAX = 300;

/** Max per-job sections rendered in one batch email (rest are summarised). */
const EMAIL_SECTION_CAP = 10;

/** Keys on `created_at`, not `updated_at` — see buildStrandedAssetJobAlert's caller. */
export interface StrandedAssetJobInput {
  id: string;
  uploadId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface JobSummary {
  id: string;
  uploadId: string;
  status: string;
  attempts: number;
  lastErrorSnippet: string;
  createdAt: string;
}

export interface StrandedAssetJobAlertLog {
  event: 'print_asset_job_stranded';
  count: number;
  jobs: JobSummary[];
}

export interface StrandedAssetJobSentryPayload {
  message: string;
  level: 'warning';
  extra: { count: number; jobs: JobSummary[] };
}

export interface StrandedAssetJobAlert {
  log: StrandedAssetJobAlertLog;
  sentry: StrandedAssetJobSentryPayload;
  email: { subject: string; html: string };
}

export interface StrandedAssetJobSweepResult {
  scanned: number;
  alerted: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarise(job: StrandedAssetJobInput): JobSummary {
  const raw = job.lastError ?? '—';
  return {
    id: job.id,
    uploadId: job.uploadId,
    status: job.status,
    attempts: job.attempts,
    lastErrorSnippet: raw.length > LAST_ERROR_MAX ? raw.slice(0, LAST_ERROR_MAX) + '…' : raw,
    createdAt: job.createdAt,
  };
}

/**
 * Build the structured log + Sentry payload (warning) + studio email for a batch
 * of stranded print-asset jobs. PURE — the caller does the log/capture/send and
 * only marks `stranded_alerted_at` AFTER the email succeeds.
 */
export function buildStrandedAssetJobAlert(jobs: StrandedAssetJobInput[]): StrandedAssetJobAlert {
  const count = jobs.length;
  const summaries = jobs.map(summarise);

  const log: StrandedAssetJobAlertLog = {
    event: 'print_asset_job_stranded',
    count,
    jobs: summaries,
  };

  const sentry: StrandedAssetJobSentryPayload = {
    message: 'print_asset_job_stranded',
    level: 'warning',
    extra: { count, jobs: summaries },
  };

  const shown = summaries.slice(0, EMAIL_SECTION_CAP);
  const remaining = count - shown.length;
  const hours = STRANDED_ASSET_JOB_AFTER_MS / (60 * 60 * 1000);
  const subject = `[Print assets] ${count} zadanie/a utknęło bez przetwarzania (>${hours}h)`;

  const parts: string[] = [
    emailParagraph(
      `<strong>${count} zadanie/a przetwarzania plików (print_asset_jobs) tkwi w stanie <code>queued</code>/<code>failed_retryable</code> od ponad ${hours} godzin.</strong>`,
    ),
    emailMutedParagraph(
      'Zwykle zadanie kończy się w kilka minut — utknięcie oznacza, że wiadomość nigdy nie trafiła do kolejki ASSET_JOBS_QUEUE (wysyłka zawiodła już PO zapisaniu wiersza) albo że kolejka nie dostarcza. Odzysk: dla <code>queued</code> ponów POST /v1/jobs dla tego samego assetId (ten sam wiersz zostanie odzyskany, a wiadomość wysłana ponownie), dla <code>failed_retryable</code> użyj POST /v1/jobs/{id}/retry. Każde zadanie jest sygnalizowane tylko raz (stranded_alerted_at).',
    ),
    ...shown.map((s) =>
      emailDetailTable([
        { label: 'Job', value: escapeHtml(s.id) },
        { label: 'Upload', value: escapeHtml(s.uploadId) },
        { label: 'Status', value: escapeHtml(s.status) },
        { label: 'Próby', value: String(s.attempts) },
        { label: 'Błąd', value: escapeHtml(s.lastErrorSnippet) },
        { label: 'Utknęło od', value: escapeHtml(s.createdAt) },
      ]),
    ),
  ];
  if (remaining > 0) {
    parts.push(emailMutedParagraph(`…i ${remaining} kolejnych (pominięte w e-mailu, pełna lista w logach workera).`));
  }

  return {
    log,
    sentry,
    email: { subject, html: resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', parts.join('')) },
  };
}

/**
 * One sweep pass, called from worker.ts's `scheduled` handler. Mirrors
 * worker.ts's `sweepStrandedJobs` step for step: query unalerted stranded rows →
 * log + Sentry (warning) + studio email → mark `stranded_alerted_at` only AFTER
 * the email succeeds, so a transient Resend failure simply retries next tick
 * instead of silently burning the once-only guard.
 *
 * Predicate keys on `created_at`, not `updated_at`: a `failed_retryable` job's
 * `updated_at` is bumped on every retry, so an `updated_at` threshold would miss
 * a job that has been failing for hours. `created_at < now()-4h` on these
 * statuses means "existed >4h and still never reached a terminal state" = stuck.
 *
 * Throws on a query/mark failure — the caller alerts a dead sweep.
 */
export async function sweepStrandedAssetJobs(env: CloudflareEnv): Promise<StrandedAssetJobSweepResult> {
  const supabase = supabaseFromEnv(env);
  const cutoff = new Date(Date.now() - STRANDED_ASSET_JOB_AFTER_MS).toISOString();

  const { data, error } = await supabase
    .from('print_asset_jobs')
    .select('id, upload_id, status, attempts, last_error, created_at')
    .in('status', STRANDED_ASSET_JOB_STATUSES as unknown as string[])
    .lt('created_at', cutoff)
    .is('stranded_alerted_at', null)
    .limit(STRANDED_ASSET_JOB_BATCH_LIMIT);
  if (error) throw new Error(`sweepStrandedAssetJobs query failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: string;
    upload_id: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
  }>;
  const inputs: StrandedAssetJobInput[] = rows.map((r) => ({
    id: r.id,
    uploadId: r.upload_id,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
  }));
  if (inputs.length === 0) return { scanned: 0, alerted: 0 }; // nothing stranded — re-run alerts nothing.

  const alert = buildStrandedAssetJobAlert(inputs);
  console.error(JSON.stringify(alert.log));
  await captureWorkerAlert(env, {
    message: alert.sentry.message,
    level: alert.sentry.level,
    extra: alert.sentry.extra,
  });
  // Email THROWS on failure — mark only after it succeeds (see above).
  await sendStudioAlertEmail(env, alert.email, 'stranded print asset jobs');

  // The `.is('stranded_alerted_at', null)` guard makes the mark idempotent: a
  // concurrent/re-run sweep cannot double-mark. `updated_at` is deliberately NOT
  // bumped — that column is the job's own progress clock, and the alert is not
  // job progress.
  const { error: markErr } = await supabase
    .from('print_asset_jobs')
    .update({ stranded_alerted_at: new Date().toISOString() })
    .in('id', inputs.map((j) => j.id))
    .is('stranded_alerted_at', null);
  if (markErr) throw new Error(`sweepStrandedAssetJobs mark failed: ${markErr.message}`);

  console.log(JSON.stringify({ event: 'print_asset_job_stranded_alerted', count: inputs.length }));
  return { scanned: inputs.length, alerted: inputs.length };
}
