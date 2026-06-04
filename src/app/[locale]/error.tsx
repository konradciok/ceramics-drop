'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function Error({ error, reset }: Props) {
  const t = useTranslations('error');

  useEffect(() => {
    Sentry.captureException(error);
    if (process.env.NODE_ENV === 'development') {
      console.error('[error boundary]', error.digest ?? '', error);
    }
  }, [error]);

  return (
    <main className="error-page">
      <div className="error-page-inner">
        <div className="error-seal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h1>{t('heading')}</h1>
        <p>{t('body')}</p>
        <button className="btn btn-primary" onClick={reset}>
          {t('retry')}
        </button>
      </div>
    </main>
  );
}
