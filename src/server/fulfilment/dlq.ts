/**
 * Dead-letter-queue (DLQ) alert builder for `prodigi-fulfilment-dlq`.
 *
 * A message only reaches the DLQ after exhausting every retry on the primary
 * `prodigi-fulfilment` consumer (`max_retries: 10`) — i.e. processJob failed
 * for 10 deliveries. The DLQ consumer is ALERT-ONLY: it logs + fires Sentry +
 * emails the studio, then `ackAll()`. It NEVER retries/requeues — a poison
 * message must not loop.
 *
 * This module is PURE (no I/O, no Sentry, no email, no env): it builds the
 * structured log line, the Sentry payload, and the email HTML fragments. The
 * worker (`worker.ts`) does the actual sends — mirroring the pure
 * `decideMessageDisposition` + actor-in-handler pattern so the alert logic is
 * unit-testable without real Sentry or Resend.
 */
import type { FulfilmentJobMessage } from '../prodigi/types';
import {
  emailDetailTable,
  emailMutedParagraph,
  emailParagraph,
  resendTemplateHtml,
} from '@/lib/email-layout';

export const DLQ_QUEUE_NAME = 'prodigi-fulfilment-dlq';

/** Max body chars retained in the log/Sentry snippet (keeps events small). */
const BODY_SNIPPET_MAX = 200;
/** Max per-message sections rendered in one batch email (rest are summarised). */
const EMAIL_SECTION_CAP = 10;

/** Raw DLQ message — body is treated as possibly-malformed (poison). */
export interface DlqMessageInput {
  id: string;
  body: unknown;
  attempts: number;
}

export interface DlqAlertLog {
  event: 'prodigi_dlq_message';
  queue: string;
  messageId: string;
  orderId: string | null;
  jobId: string | null;
  attempts: number;
  bodySnippet: string;
}

export interface DlqSentryPayload {
  message: string;
  level: 'error';
  extra: {
    queue: string;
    messageId: string;
    orderId: string | null;
    jobId: string | null;
    attempts: number;
    bodySnippet: string;
  };
}

export interface DlqAlert {
  log: DlqAlertLog;
  sentry: DlqSentryPayload;
  /** Inner-HTML fragment for this message inside the batch studio email. */
  emailSection: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Read orderId/jobId defensively and produce a bounded body snippet. */
function readBody(body: unknown): {
  orderId: string | null;
  jobId: string | null;
  snippet: string;
} {
  const b = body as Partial<FulfilmentJobMessage> | null;
  const orderId = typeof b?.orderId === 'string' ? b.orderId : null;
  const jobId = typeof b?.jobId === 'string' ? b.jobId : null;
  let snippet: string;
  try {
    snippet = JSON.stringify(body) ?? String(body);
  } catch {
    snippet = String(body);
  }
  if (snippet.length > BODY_SNIPPET_MAX) snippet = snippet.slice(0, BODY_SNIPPET_MAX) + '…';
  return { orderId, jobId, snippet };
}

/**
 * Build the structured log + Sentry payload + email fragment for ONE DLQ
 * message. Pure — callers do the actual log/capture/send.
 */
export function buildDlqAlert(msg: DlqMessageInput): DlqAlert {
  const { orderId, jobId, snippet } = readBody(msg.body);

  const log: DlqAlertLog = {
    event: 'prodigi_dlq_message',
    queue: DLQ_QUEUE_NAME,
    messageId: msg.id,
    orderId,
    jobId,
    attempts: msg.attempts,
    bodySnippet: snippet,
  };

  const sentry: DlqSentryPayload = {
    message: 'prodigi_dlq_poison_message',
    level: 'error',
    extra: {
      queue: DLQ_QUEUE_NAME,
      messageId: msg.id,
      orderId,
      jobId,
      attempts: msg.attempts,
      bodySnippet: snippet,
    },
  };

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Wiadomość', value: escapeHtml(msg.id) },
    { label: 'Zamówienie', value: escapeHtml(orderId ?? '—') },
    { label: 'Job', value: escapeHtml(jobId ?? '—') },
    { label: 'Próby', value: String(msg.attempts) },
    { label: 'Treść', value: escapeHtml(snippet) },
  ];
  const emailSection = [
    emailParagraph('<strong>Trutka z kolejki Prodigi (DLQ).</strong>'),
    emailDetailTable(rows),
    emailMutedParagraph(
      'Wiadomość trafiła do DLQ po wyczerpaniu ponowień (max_retries). Wymaga ręcznej weryfikacji w Supabase / Prodigi.',
    ),
  ].join('');

  return { log, sentry, emailSection };
}

/**
 * Pure: build the subject + full HTML for the batch DLQ studio email from the
 * per-message sections. Renders at most `EMAIL_SECTION_CAP` sections and notes
 * the remainder, so a 100-message DLQ batch does not produce a megabyte email.
 */
export function buildDlqBatchAlertEmail(sections: string[]): {
  subject: string;
  html: string;
} {
  const count = sections.length;
  const shown = sections.slice(0, EMAIL_SECTION_CAP);
  const remaining = count - shown.length;
  const subject = `[DLQ] Prodigi — ${count} wiadomość/i w kolejce martwych wiadomości`;

  const parts: string[] = [
    emailParagraph(
      `<strong>${count} wiadomość/i z kolejki Prodigi trafiła do DLQ i wymaga ręcznej obsługi.</strong>`,
    ),
    emailMutedParagraph(
      'Kolejka DLQ jest alert-only — nic nie jest ponawiane automatycznie. Sprawdź Sentry oraz tabelę fulfilment_jobs / prodigi_orders.',
    ),
    ...shown,
  ];
  if (remaining > 0) {
    parts.push(emailMutedParagraph(`…i ${remaining} kolejnych (pominięte w e-mailu, pełna lista w logach workera).`));
  }

  return { subject, html: resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', parts.join('')) };
}
