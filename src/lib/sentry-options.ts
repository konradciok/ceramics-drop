import type { BrowserOptions, EdgeOptions, NodeOptions } from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

const isDev = process.env.NODE_ENV === 'development';

/** The event type Sentry hands `beforeSend` — derived so we never guess the export name. */
type SentryEvent = Parameters<NonNullable<NodeOptions['beforeSend']>>[0];

const SCRUB_HEADERS = new Set(['cookie', 'authorization', 'x-forwarded-for']);
const MAX_EXTRA_STRING = 2_000;

/**
 * Strip request cookies + sensitive headers and truncate oversized `extra`
 * strings before an event leaves the process. The worker forwards
 * `extra: alert.sentry.extra` unscrubbed (worker.ts:112,291); this is the single
 * choke point that bounds it. Pure + exported for unit testing.
 */
export function scrubSentryEvent(event: SentryEvent): SentryEvent {
  if (event.request) {
    delete event.request.cookies;
    // Strip the query string from the request URL (and the separate query_string
    // field): it can carry capability tokens — ?sale= / ?preview= /
    // payment_intent_client_secret / ?order= — the same vectors Plan 1 redacts for
    // analytics, and Sentry captures the URL even with sendDefaultPii:false. Dropped
    // wholesale so a future sensitive param needs no allowlist maintained here.
    if (typeof event.request.url === 'string') {
      event.request.url = event.request.url.split(/[?#]/)[0];
    }
    delete event.request.query_string;
    if (event.request.headers) {
      // Header names are case-insensitive — a runtime may deliver `Cookie` /
      // `Authorization` / `X-Forwarded-For` in any casing. Compare on a
      // lowercased key so none slip through, then delete by the original key.
      for (const key of Object.keys(event.request.headers)) {
        if (SCRUB_HEADERS.has(key.toLowerCase())) delete event.request.headers[key];
      }
    }
  }
  if (event.extra) {
    for (const [k, v] of Object.entries(event.extra)) {
      if (typeof v === 'string' && v.length > MAX_EXTRA_STRING) {
        event.extra[k] = `${v.slice(0, MAX_EXTRA_STRING)}…`;
      }
    }
  }
  return event;
}

/** Shared Sentry init options for all Next.js runtimes. */
export function getBaseSentryOptions(): Partial<NodeOptions & EdgeOptions & BrowserOptions> {
  if (!dsn) {
    return {};
  }

  return {
    dsn,
    // Local `next dev` / E2E runs share the production project's DSN via
    // .env.local and were landing there as environment=development noise.
    // Opt back in per shell with SENTRY_SEND_IN_DEV=1 when debugging Sentry itself.
    enabled: !isDev || process.env.SENTRY_SEND_IN_DEV === '1',
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    // Correlate every event with the release that shipped it. Inlined at build
    // from package.json (next.config.ts) — matches the source-map `release`.
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    tracesSampleRate: isDev ? 1.0 : 0.1,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    ignoreErrors: [
      // Android WebView GC artifact from GTM/GA4 keyboard telemetry — not our code.
      /Java object is gone/,
      // Instagram in-app browser bridge scripts (navigation_performance_logger,
      // sendDataToNative) failing on their own native handlers — not our code.
      /454: Handling is disabled/,
      /Error invoking postMessage/,
      /window\.webkit\.messageHandlers/,
    ],
  };
}

export function isSentryEnabled(): boolean {
  return Boolean(dsn);
}
