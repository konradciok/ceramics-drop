/**
 * M-26: alert builder for a Prodigi order-creation `outcome` that is not plain
 * success. `CreatedWithIssues` / unknown outcomes mean the remote order EXISTS
 * but carries issues the studio must look at; `OnHold` means it exists but will
 * not progress without action. process-job persists the diagnostics and sends
 * these alerts — previously every 200 POST was read as unqualified success.
 *
 * Like the sibling builders (failed-action-alert.ts, dlq.ts, stranded-job-alert.ts)
 * this module is PURE (no I/O / Sentry / email / env): it builds the structured
 * log line, the Sentry payload, and the studio email. The caller does the sends.
 */
import type { ProdigiOrderIssue } from '../prodigi/types';
import {
  emailDetailTable,
  emailMutedParagraph,
  emailParagraph,
  resendTemplateHtml,
} from '@/lib/email-layout';

export interface OutcomeAlertInput {
  orderId: string;
  jobId: string;
  prodigiOrderId: string;
  outcome: string;
  issues: ProdigiOrderIssue[];
}

export interface OutcomeAlert {
  log: {
    event: 'prodigi_order_outcome_issues';
    orderId: string;
    jobId: string;
    prodigiOrderId: string;
    outcome: string;
    issues: ProdigiOrderIssue[];
  };
  sentry: {
    message: 'prodigi_order_outcome_issues';
    level: 'error';
    extra: Record<string, unknown>;
  };
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

/**
 * Serialize `{ outcome, issues }` as JSON for `fulfilment_jobs.last_error`
 * (a Postgres `text` column — no length cap, so nothing is truncated and the
 * studio keeps every provider issue code + description verbatim).
 */
export function serializeOutcomeIssues(outcome: string, issues: ProdigiOrderIssue[]): string {
  try {
    return JSON.stringify({ outcome, issues });
  } catch {
    // Circular/unserializable payloads can't happen for parsed JSON responses,
    // but never let diagnostics serialization crash the job.
    return JSON.stringify({ outcome, issues: '[unserializable]' });
  }
}

export function buildOutcomeAlert(input: OutcomeAlertInput): OutcomeAlert {
  const { orderId, jobId, prodigiOrderId, outcome, issues } = input;

  const log = {
    event: 'prodigi_order_outcome_issues' as const,
    orderId,
    jobId,
    prodigiOrderId,
    outcome,
    issues,
  };

  const sentry = {
    message: 'prodigi_order_outcome_issues' as const,
    level: 'error' as const,
    extra: { orderId, jobId, prodigiOrderId, outcome, issues },
  };

  const issueRows = issues.length > 0
    ? issues.map((iss) =>
        emailDetailTable([
          { label: 'Kod', value: escapeHtml(String(iss.errorCode ?? '—')) },
          { label: 'Obiekt', value: escapeHtml(String(iss.objectId ?? '—')) },
          { label: 'Opis', value: escapeHtml(String(iss.description ?? '—')) },
        ]),
      )
    : [emailMutedParagraph('Prodigi nie zwróciło szczegółów (pusta lista issues).')];

  const html = resendTemplateHtml().replace(
    '{{{MAIN_CONTENT}}}',
    [
      emailParagraph(
        `<strong>Prodigi utworzyło zamówienie z problemami (outcome: <code>${escapeHtml(outcome)}</code>).</strong>`,
      ),
      emailDetailTable([
        { label: 'Zamówienie', value: escapeHtml(orderId) },
        { label: 'Job', value: escapeHtml(jobId) },
        { label: 'Prodigi', value: escapeHtml(prodigiOrderId) },
      ]),
      ...issueRows,
      emailMutedParagraph(
        'Zamówienie ISTNIEJE po stronie Prodigi (nie będzie ponawiane) — sprawdź dashboard Prodigi i tabelę fulfilment_jobs (pełne issues w last_error).',
      ),
    ].join(''),
  );

  return {
    log,
    sentry,
    email: { subject: `[Prodigi] Zamówienie ${prodigiOrderId} utworzone z problemami (${outcome})`, html },
  };
}
