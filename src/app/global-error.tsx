'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pl">
      <body>
        <main className="error-page">
          <div className="error-page-inner">
            <h1>Something went wrong</h1>
            <p>Please refresh the page or try again later.</p>
          </div>
        </main>
      </body>
    </html>
  );
}
