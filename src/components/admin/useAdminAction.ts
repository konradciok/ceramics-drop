'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { runAdminAction, type AdminActionOptions } from './admin-action';
import { useToast } from './Toast';

/**
 * The shared "action button" behaviour: track which action is in-flight (`busy`
 * holds its key), POST via runAdminAction, toast the outcome, and refresh the
 * server component on success. Replaces the fetch→setMsg→router.refresh block
 * that was copy-pasted across admin components.
 */
export function useAdminAction() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // Ref guard so a fast double-click can't fire overlapping POSTs before `busy`
  // state is observed on the next render.
  const inFlight = useRef(false);

  const run = useCallback(
    async (
      key: string,
      path: string,
      opts: AdminActionOptions & { refresh?: boolean; stickyToast?: boolean } = {},
    ): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(key);
      try {
        const outcome = await runAdminAction(path, opts);
        toast.notify(outcome.ok, outcome.text, { sticky: opts.stickyToast });
        if (outcome.ok && opts.refresh !== false) router.refresh();
        return outcome.ok;
      } finally {
        setBusy(null);
        inFlight.current = false;
      }
    },
    [router, toast],
  );

  return { run, busy };
}
