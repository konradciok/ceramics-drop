import * as Sentry from '@sentry/nextjs';
import { getBaseSentryOptions, isSentryEnabled } from '@/lib/sentry-options';

if (isSentryEnabled()) {
  Sentry.init({
    ...getBaseSentryOptions(),
    // First-party tunnel (dodges ad blockers): accepts only our own DSN and
    // forwards only the envelope body — see src/app/api/sentry-tunnel/route.ts.
    tunnel: '/api/sentry-tunnel',
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
