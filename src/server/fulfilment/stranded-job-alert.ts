/**
 * M-10: cron-driven alert builder for `fulfilment_jobs` stranded in a
 * PRE-SUBMISSION non-terminal state (`queued` / `fulfilment_submitting` /
 * `failed_retryable`) for too long — the symptom of a queue that isn't
 * delivering or a job that keeps failing. The `failed_action_required` sweep
 * (failed-action-alert.ts) does NOT cover these, so a job stuck in `queued`
 * would otherwise sit unnoticed forever (this is exactly what C-2 produced).
 *
 * We deliberately exclude `fulfilment_submitted` / `in_production`: those are
 * legitimate long-lived waiting states (the order is at Prodigi, awaiting
 * production/shipping callbacks) and can sit for days normally.
 *
 * Like the sibling alert builders (failed-action-alert.ts, dlq.ts) this module
 * is PURE (no I/O / Sentry / email / env): it builds the log line, the Sentry
 * payload, and the email HTML. The worker does the actual sends and marks
 * `alerted_at` afterwards (the once-only idempotency guard).
 */
import {
  emailDetailTable,
  emailMutedParagraph,
  emailParagraph,
  resendTemplateHtml,
} from '@/lib/email-layout';

/** The non-terminal statuses this watchdog treats as "stranded" when old. */
export const STRANDED_STATUSES = ['queued', 'fulfilment_submitting', 'failed_retryable'] as const;

/** Max per-job sections rendered in one batch email (rest are summarised). */
const EMAIL_SECTION_CAP = 10;

/** A stranded job row, as selected by the sweep query. */
export interface StrandedJobInput {
  id: string;
  orderId: string;
  status: string;
  attempts: number;
  createdAt: string;
}

interface JobSummary {
  id: string;
  orderId: string;
  status: string;
  attempts: number;
  createdAt: string;
}

export interface StrandedJobAlertLog {
  event: 'fulfilment_job_stranded';
  count: number;
  jobs: JobSummary[];
}

export interface StrandedJobSentryPayload {
  message: string;
  level: 'warning';
  extra: { count: number; jobs: JobSummary[] };
}

export interface StrandedJobAlert {
  log: StrandedJobAlertLog;
  sentry: StrandedJobSentryPayload;
  email: { subject: string; html: string };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarise(job: StrandedJobInput): JobSummary {
  return {
    id: job.id,
    orderId: job.orderId,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
  };
}

/**
 * Build the structured log + Sentry payload (warning) + studio email for a batch
 * of stranded fulfilment jobs. Pure — the caller does the log/capture/send and
 * only marks `alerted_at` AFTER the email succeeds.
 */
export function buildStrandedJobAlert(jobs: StrandedJobInput[]): StrandedJobAlert {
  const count = jobs.length;
  const summaries = jobs.map(summarise);

  const log: StrandedJobAlertLog = {
    event: 'fulfilment_job_stranded',
    count,
    jobs: summaries,
  };

  const sentry: StrandedJobSentryPayload = {
    message: 'fulfilment_job_stranded',
    level: 'warning',
    extra: { count, jobs: summaries },
  };

  const shown = summaries.slice(0, EMAIL_SECTION_CAP);
  const remaining = count - shown.length;
  const subject = `[Fulfilment] ${count} zadanie/a utknęło w stanie nieterminalnym (>2h)`;

  const parts: string[] = [
    emailParagraph(
      `<strong>${count} zadanie/a realizacji (fulfilment_jobs) utknęło w stanie przed-wysyłkowym (<code>queued</code>/<code>fulfilment_submitting</code>/<code>failed_retryable</code>) od ponad 2 godzin.</strong>`,
    ),
    emailMutedParagraph(
      'Zwykle zadanie przechodzi do <code>fulfilment_submitted</code> w kilka sekund — utknięcie oznacza, że kolejka nie dostarcza wiadomości albo Prodigi/asset zawodzi. Sprawdź fulfilment_jobs / DLQ i logi workera. Każde zadanie jest sygnalizowane tylko raz (alerted_at).',
    ),
    ...shown.map((s) =>
      emailDetailTable([
        { label: 'Job', value: escapeHtml(s.id) },
        { label: 'Zamówienie', value: escapeHtml(s.orderId) },
        { label: 'Status', value: escapeHtml(s.status) },
        { label: 'Próby', value: String(s.attempts) },
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
