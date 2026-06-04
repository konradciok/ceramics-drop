import * as Sentry from '@sentry/nextjs';
import { getBaseSentryOptions, isSentryEnabled } from '@/lib/sentry-options';

if (isSentryEnabled()) {
  Sentry.init({
    ...getBaseSentryOptions(),
  });
}
