'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useFilter } from '@/store/filter';
import { STATUS_FILTERS, type StatusFilter as Status } from '@/lib/status-filter';
import { useMounted } from '@/lib/use-mounted';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

/**
 * Segmented control (Wszystkie · Dostępne · Sprzedane) that drives the shared
 * filter store. Single-select radiogroup with roving tabindex + arrow-key nav.
 * Until mounted it shows the SSR default ("all") to avoid a hydration mismatch
 * with the persisted choice. Used on /sklep (sticky nav) and collection pages.
 */
export function StatusFilter() {
  const t = useTranslations();
  const mounted = useMounted();
  const stored = useFilter((s) => s.status);
  const setStatus = useFilter((s) => s.setStatus);
  const active: Status = mounted ? stored : 'all';
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Static keys (not a runtime-built `filter.${status}`) so next-intl can
  // resolve them and a renamed key would surface at build time.
  const labels: Record<Status, string> = {
    all: t('filter.all'),
    available: t('filter.available'),
    sold: t('filter.sold'),
  };

  const choose = (status: Status) => {
    if (status === active) return;
    setStatus(status);
    // Demand signal: how often visitors narrow the shop. Reuses the single
    // site_engagement event keyed by engagement_type (see docs/analytics-stack.md).
    pushDataLayer(buildEngagementEvent('shop_filter', { filter_status: status }));
  };

  // WAI-ARIA radiogroup keys: arrows wrap to next/previous, Home/End jump to
  // the ends. Selecting also moves focus (roving tabindex).
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = STATUS_FILTERS.length - 1;
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % STATUS_FILTERS.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + STATUS_FILTERS.length) % STATUS_FILTERS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    choose(STATUS_FILTERS[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className="status-filter" role="radiogroup" aria-label={t('filter.label')}>
      {STATUS_FILTERS.map((status, i) => {
        const on = status === active;
        return (
          <button
            key={status}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={on ? 'on' : undefined}
            onClick={() => choose(status)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {labels[status]}
          </button>
        );
      })}
    </div>
  );
}
