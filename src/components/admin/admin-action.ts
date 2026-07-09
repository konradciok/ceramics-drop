/* ============================================================
   Admin action core — pure fetch + interpret
   ------------------------------------------------------------
   The shared logic behind every admin mutation button: POST JSON, read the
   response, map it to an { ok, text } outcome (studio message or error reason).
   Kept free of React so it is unit-testable in the node env; the useAdminAction
   hook wires it to busy state, toasts, and router.refresh().
   ============================================================ */

export interface AdminActionOutcome {
  ok: boolean;
  text: string;
}

export interface AdminActionOptions {
  body?: unknown;
  /** Success text when the API returns no `message`. */
  successText?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST `body` (as JSON) to `path` and interpret the result. Mirrors the pattern
 * previously copy-pasted across admin action components: a non-2xx maps to
 * `{ ok:false, text: data.error ?? 'HTTP <status>' }`, a network throw to a
 * generic error, and success to the API `message` (or `successText`).
 */
export async function runAdminAction(
  path: string,
  opts: AdminActionOptions = {},
): Promise<AdminActionOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) return { ok: false, text: data.error || `HTTP ${res.status}` };
    return { ok: true, text: data.message || opts.successText || 'Gotowe.' };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : 'Błąd' };
  }
}
