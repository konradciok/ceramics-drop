import type { BrowserOptions, EdgeOptions, NodeOptions } from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

const isDev = process.env.NODE_ENV === 'development';

/** Shared Sentry init options for all Next.js runtimes. */
export function getBaseSentryOptions(): Partial<NodeOptions & EdgeOptions & BrowserOptions> {
  if (!dsn) {
    return {};
  }

  return {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: isDev ? 1.0 : 0.1,
    sendDefaultPii: false,
    ignoreErrors: [
      // Android WebView GC artifact from GTM/GA4 keyboard telemetry — not our code.
      /Java object is gone/,
    ],
  };
}

export function isSentryEnabled(): boolean {
  return Boolean(dsn);
}
