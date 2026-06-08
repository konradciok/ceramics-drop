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

  useEffect(() => {
    const firedDepths = new Set<number>();
    const timers = [
      window.setTimeout(() => {
        pushDataLayer(
          buildEngagementEvent('time_on_page', {
            engagement_seconds: 30,
            page_path: redactSensitiveUrl(`${window.location.pathname}${window.location.search}`),
          }),
        );
      }, 30000),
    ];

    let rafId = 0;
    let ticking = false;

    const measureDepth = () => {
      ticking = false;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;

      const depth = Math.round((window.scrollY / scrollable) * 100);
      for (const threshold of [50, 90]) {
        if (depth >= threshold && !firedDepths.has(threshold)) {
          firedDepths.add(threshold);
          pushDataLayer(
            buildEngagementEvent('scroll_depth', {
              percent_scrolled: threshold,
              page_path: redactSensitiveUrl(`${window.location.pathname}${window.location.search}`),
            }),
          );
        }
      }

      if (firedDepths.size === 2) {
        window.removeEventListener('scroll', onScroll);
      }
    };

    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        rafId = window.requestAnimationFrame(measureDepth);
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    // Initial check: schedule via rAF so the path is consistent with scroll events
    ticking = true;
    rafId = window.requestAnimationFrame(measureDepth);

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.cancelAnimationFrame(rafId);
    };
  }, [pathname]);

  return null;
}
