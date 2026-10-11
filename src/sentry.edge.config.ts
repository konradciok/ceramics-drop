import * as Sentry from '@sentry/nextjs';
import { getServerSentryOptions, isSentryEnabled } from '@/lib/sentry-options';

if (isSentryEnabled()) {
  Sentry.init({
    ...getServerSentryOptions(),
  });
}
