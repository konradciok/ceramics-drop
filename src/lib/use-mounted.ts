'use client';

import { useEffect, useState } from 'react';

/**
 * False during SSR and the first client render, true after mount. Used to defer
 * persisted-store (localStorage) values until after hydration so the server HTML
 * and the first client render match. The status filter (acc_filter_v1) uses this
 * to render the SSR default ("all") first, then apply the saved choice.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
