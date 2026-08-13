import { EMAIL, EMAIL_FROM } from './email-addresses';

/**
 * Send a studio alert email via Resend, from contexts WITHOUT a request
 * AsyncLocalStorage (queue consumer, scheduled/cron) where the
 * `getCloudflareContext()`-based senders in src/lib/email.ts don't apply —
 * `env` is passed explicitly. THROWS on missing config or a Resend failure so
 * callers can decide: cron sweeps only mark their `*_alerted_at` once this
 * resolves; best-effort callers `.catch()` and log.
 *
 * Extracted from worker.ts (Plan 11) so the queue consumer (process-job) can
 * reuse the exact sender the cron sweeps use.
 */
export async function sendStudioAlertEmail(
  env: CloudflareEnv,
  email: { subject: string; html: string },
  context: string,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error(`RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing — cannot alert: ${context}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [env.STUDIO_NOTIFY_EMAIL],
        reply_to: EMAIL.contact,
        subject: email.subject,
        html: email.html,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
