'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { usePathname } from 'next/navigation';
import { buildEngagementEvent, buildPageViewEvent, pushDataLayer, redactSensitiveUrl } from '@/lib/analytics';

export function AnalyticsEvents() {
  const pathname = usePathname();
  const locale = useLocale();

  useEffect(() => {
    pushDataLayer(
      buildPageViewEvent({
        pageLocation: window.location.href,
        pagePath: `${window.location.pathname}${window.location.search}`,
        pageTitle: document.title,
        locale,
      }),
    );
  }, [locale, pathname]);

  // Scroll depth is deliberately not measured here — GA4 Enhanced Measurement is
  // the single owner of scroll (and form) interactions (audit N-3). Only the
  // dwell-time signal, which EM does not provide, stays hand-rolled.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      pushDataLayer(
        buildEngagementEvent('time_on_page', {
          engagement_seconds: 30,
          page_path: redactSensitiveUrl(`${window.location.pathname}${window.location.search}`),
        }),
      );
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return null;
}
