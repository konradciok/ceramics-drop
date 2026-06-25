import type { captureRequestError } from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Type-only import above; load Sentry lazily so no Node.js-only code
// enters the edge bundle at module evaluation time.
export const onRequestError: typeof captureRequestError = async (...args) => {
  const { captureRequestError: fn } = await import('@sentry/nextjs');
  return fn(...args);
};
