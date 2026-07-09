'use client';

import { useEffect } from 'react';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

/** Fires a single showroom_view engagement event on /showroom load. */
export function ShowroomViewAnalytics({ count }: { count: number }) {
  useEffect(() => {
    pushDataLayer(buildEngagementEvent('showroom_view', { count }));
    // Fire once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
