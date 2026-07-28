'use client';

import { useStripUrlParams } from '@/lib/use-strip-url-token';

/**
 * Renders nothing; strips the named capability-token params from the URL on
 * mount. A client host for server components (the PDP) that can't call the
 * useStripUrlParams hook directly. See the N-1 finding in
 * docs/audits/analytics-architecture-audit-2026-07-28.md.
 */
export function StripUrlToken({ names }: { names: readonly string[] }) {
  useStripUrlParams(names);
  return null;
}
