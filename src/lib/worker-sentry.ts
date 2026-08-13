/**
 * M-16: the custom Worker bundle runs `queue()`/`scheduled()`/DLQ handlers
 * OUTSIDE the Next.js instrumentation that calls `Sentry.init` — so
 * `@sentry/nextjs`'s `Sentry.captureMessage` there can be a silent no-op on a
 * cold isolate, exactly where the poison-message / failed-action / stalled-job
 * alerts live. Rather than add a second Sentry SDK to the worker bundle (bundle
 * size + the risk of double-instrumenting the OpenNext `fetch` path + the DO
 * re-export constraints), we POST the alert directly to the Sentry ingestion
 * envelope endpoint. Self-contained, dependency-free, and unit-testable.
 *
 * Envelope format per https://develop.sentry.dev/sdk/data-model/envelopes/ —
 * three newline-delimited lines: envelope header, item header, event payload.
 * The fetch path keeps its own `@sentry/nextjs` instrumentation (unchanged).
 */

export type WorkerAlertLevel = 'fatal' | 'error' | 'warning' | 'info';

export interface WorkerAlert {
  message: string;
  level?: WorkerAlertLevel;
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
}

interface ParsedDsn {
  host: string;
  projectId: string;
  publicKey: string;
}

/** Parse a Sentry DSN `https://PUBLIC_KEY[:SECRET]@HOST/PROJECT_ID`. Returns null if malformed. */
export function parseSentryDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!u.hostname || !u.username || !projectId) return null;
    return { host: u.hostname, projectId, publicKey: u.username };
  } catch {
    return null;
  }
}

/** Build the ingestion envelope body (pure — deterministic given eventId/nowIso). */
export function buildEventEnvelope(
  dsn: string,
  alert: WorkerAlert,
  opts: { eventId: string; nowIso: string },
): string {
  const envelopeHeader = JSON.stringify({ event_id: opts.eventId, dsn, sent_at: opts.nowIso });
  const itemHeader = JSON.stringify({ type: 'event', content_type: 'application/json' });
  const payload = JSON.stringify({
    event_id: opts.eventId,
    timestamp: opts.nowIso,
    platform: 'javascript',
    level: alert.level ?? 'error',
    message: alert.message,
    // Marks worker-context events so they are distinguishable from fetch-path ones.
    tags: { runtime: 'worker-handler', ...(alert.tags ?? {}) },
    ...(alert.extra ? { extra: alert.extra } : {}),
  });
  return `${envelopeHeader}\n${itemHeader}\n${payload}`;
}

/**
 * Fire-and-forget alert to Sentry from a worker (non-fetch) handler. Fail-soft:
 * a missing/malformed DSN or a network/timeout error is logged and swallowed so
 * it never blocks the ack/mark. Bounded by an 8s timeout (matches the worker's
 * Resend calls).
 */
export async function captureWorkerAlert(env: CloudflareEnv, alert: WorkerAlert): Promise<void> {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return; // dev/preview without Sentry — no-op, never throw.
  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    console.error(JSON.stringify({ event: 'worker_sentry_bad_dsn' }));
    return;
  }
  const url = `https://${parsed.host}/api/${parsed.projectId}/envelope/?sentry_key=${parsed.publicKey}&sentry_version=7`;
  const body = buildEventEnvelope(dsn, alert, {
    eventId: crypto.randomUUID().replace(/-/g, ''),
    nowIso: new Date().toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body,
      signal: controller.signal,
    });
    // fetch() resolves for 4xx/5xx — an ingest rejection (429 rate-limit, 5xx)
    // must still be logged, or the alert silently vanishes (the very M-16 no-op).
    if (!res.ok) {
      console.error(JSON.stringify({ event: 'worker_sentry_send_failed', status: res.status }));
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'worker_sentry_send_failed', error: String(e) }));
  } finally {
    clearTimeout(timer);
  }
}
