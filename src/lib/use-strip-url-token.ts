'use client';

import { useEffect } from 'react';

/**
 * Remove the given query params from the current URL in place, via
 * history.replaceState (no navigation, no re-render). Next 16's App Router keeps
 * its internal state in sync with native history.replaceState, so this is safe
 * to call from a client component. No-op on the server, or when none of the
 * params are present.
 *
 * Used to scrub capability tokens (?sale=, ?preview=,
 * ?payment_intent[_client_secret]=) from document.location AFTER the app has
 * read them, so gtag's ambient page_location, browser history, and the Referer
 * header never carry the secret. See the N-1 finding in
 * docs/audits/analytics-architecture-audit-2026-07-28.md.
 */
export function stripUrlParams(names: readonly string[]): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of names) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return;
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/**
 * Client hook: strip the given capability-token params from the URL once, on
 * mount — after the server component that owns the route has already read them.
 * The name list is a per-call-site literal, so the effect deliberately runs once.
 */
export function useStripUrlParams(names: readonly string[]): void {
  useEffect(() => {
    stripUrlParams(names);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
