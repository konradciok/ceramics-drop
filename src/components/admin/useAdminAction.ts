'use client';

import { useCallback, useState } from 'react';
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

  const run = useCallback(
    async (
      key: string,
      path: string,
      opts: AdminActionOptions & { refresh?: boolean } = {},
    ): Promise<boolean> => {
      setBusy(key);
      const outcome = await runAdminAction(path, opts);
      toast.notify(outcome.ok, outcome.text);
      if (outcome.ok && opts.refresh !== false) router.refresh();
      setBusy(null);
      return outcome.ok;
    },
    [router, toast],
  );

  return { run, busy };
}
