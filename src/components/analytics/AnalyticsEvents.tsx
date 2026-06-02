'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { usePathname } from 'next/navigation';
import { buildEngagementEvent, buildPageViewEvent, pushDataLayer } from '@/lib/analytics';

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

  useEffect(() => {
    const firedDepths = new Set<number>();
    const timers = [
      window.setTimeout(() => {
        pushDataLayer(
          buildEngagementEvent('time_on_page', {
            engagement_seconds: 30,
            page_path: `${window.location.pathname}${window.location.search}`,
          }),
        );
      }, 30000),
    ];

    const onScroll = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;

      const depth = Math.round((window.scrollY / scrollable) * 100);
      for (const threshold of [50, 90]) {
        if (depth >= threshold && !firedDepths.has(threshold)) {
          firedDepths.add(threshold);
          pushDataLayer(
            buildEngagementEvent('scroll_depth', {
              percent_scrolled: threshold,
              page_path: `${window.location.pathname}${window.location.search}`,
            }),
          );
        }
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [pathname]);

  return null;
}
