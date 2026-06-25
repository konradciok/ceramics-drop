'use client';

import { useSyncExternalStore } from 'react';

// A store that never changes: subscribe is a no-op (the value can never flip
// back), the client snapshot is always true, the server snapshot always false.
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * False during SSR and the first (hydration) client render, true thereafter.
 * Used to defer persisted-store (localStorage) values until after hydration so
 * the server HTML and the first client render match. The status filter
 * (acc_filter_v1) uses this to render the SSR default ("all") first, then apply
 * the saved choice.
 *
 * Implemented with useSyncExternalStore — React replays the server snapshot for
 * the hydration render and switches to the client snapshot afterwards — which
 * gives the mounted-gate behaviour without a setState-in-effect.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
