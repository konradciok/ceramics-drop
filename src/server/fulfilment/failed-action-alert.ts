/**
 * Cron-driven alert builder for `fulfilment_jobs` stuck in
 * `failed_action_required` (e.g. Prodigi rejected an order needing manual
 * action, or the order was unpaid / missing a shipping address).
 *
 * `process-job.ts` sets `last_error` but nothing sweeps or alerts — such a job
 * could sit unnoticed. The worker `scheduled()` handler runs this sweep every
 * 15 min: it queries unalerted rows, sends the studio email + Sentry event,
 * then marks `alerted_at` (the idempotency guard — a re-run with no new rows
 * sends nothing; the same row is never re-alerted).
 *
 * This module is PURE (no I/O, no Sentry, no email, no env): it builds the
 * structured log line, the Sentry payload, and the email HTML. The worker does
 * the actual sends — mirroring `dlq.ts` so the alert logic is unit-testable
 * without real Sentry or Resend.
 */
import {
  emailDetailTable,
  emailMutedParagraph,
  emailParagraph,
  resendTemplateHtml,
} from '@/lib/email-layout';

/** Max chars of `last_error` retained in log/Sentry/email (keeps events small). */
const LAST_ERROR_MAX = 300;
/** Max per-job sections rendered in one batch email (rest are summarised). */
const EMAIL_SECTION_CAP = 10;

/** A failed_action_required job row, as selected by the sweep query. */
export interface FailedActionJobInput {
  id: string;
  orderId: string;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

interface JobSummary {
  id: string;
  orderId: string;
  attempts: number;
  lastErrorSnippet: string;
}

export interface FailedActionAlertLog {
  event: 'fulfilment_failed_action_required';
  count: number;
  jobs: JobSummary[];
}

export interface FailedActionSentryPayload {
  message: string;
  level: 'error';
  extra: { count: number; jobs: JobSummary[] };
}

export interface FailedActionAlert {
  log: FailedActionAlertLog;
  sentry: FailedActionSentryPayload;
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

function summarise(job: FailedActionJobInput): JobSummary {
  const raw = job.lastError ?? '—';
  const lastErrorSnippet = raw.length > LAST_ERROR_MAX ? raw.slice(0, LAST_ERROR_MAX) + '…' : raw;
  return { id: job.id, orderId: job.orderId, attempts: job.attempts, lastErrorSnippet };
}

/**
 * Build the structured log + Sentry payload + studio email for a batch of
 * unalerted `failed_action_required` jobs. Pure — the caller does the actual
 * log/capture/send and only marks `alerted_at` AFTER the email succeeds.
 */
export function buildFailedActionAlert(jobs: FailedActionJobInput[]): FailedActionAlert {
  const count = jobs.length;
  const summaries = jobs.map(summarise);

  const log: FailedActionAlertLog = {
    event: 'fulfilment_failed_action_required',
    count,
    jobs: summaries,
  };

  const sentry: FailedActionSentryPayload = {
    message: 'fulfilment_failed_action_required',
    level: 'error',
    extra: { count, jobs: summaries },
  };

  const shown = summaries.slice(0, EMAIL_SECTION_CAP);
  const remaining = count - shown.length;
  const subject = `[Prodigi] ${count} zadanie/a wymaga/ją ręcznej obsługi (failed_action_required)`;

  const parts: string[] = [
    emailParagraph(
      `<strong>${count} zadanie/a realizacji (fulfilment_jobs) utknęło w stanie <code>failed_action_required</code> i wymaga ręcznej weryfikacji.</strong>`,
    ),
    emailMutedParagraph(
      'Sprawdź tabelę fulfilment_jobs / prodigi_orders w Supabase oraz dashboard Prodigi. Każde zadanie jest sygnalizowane tylko raz (alerted_at).',
    ),
    ...shown.map((s) =>
      emailDetailTable([
        { label: 'Job', value: escapeHtml(s.id) },
        { label: 'Zamówienie', value: escapeHtml(s.orderId) },
        { label: 'Próby', value: String(s.attempts) },
        { label: 'Błąd', value: escapeHtml(s.lastErrorSnippet) },
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
