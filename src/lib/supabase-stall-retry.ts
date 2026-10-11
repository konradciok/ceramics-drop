/* ============================================================
   Supabase stalled-connection retry — custom fetch for the JS client
   ------------------------------------------------------------
   Production telemetry (2026-09/10): every storefront Supabase timeout
   lined up with a Workers subrequest recorded as `requestOutcome: notDone`
   with an EMPTY hostname, in the same minute and colo — the connection to
   *.supabase.co stalled before it was established, so Supabase never saw
   the request. Healthy reads finish well inside the budget (p999 ≈ 2.1 s
   over ~1M subrequests), but a stalled attempt never recovers: it simply
   burns the whole 5 s `supabaseTimeout()` budget and the read falls back.

   This wrapper splits that budget: an attempt that has produced no
   response headers after STALL_ATTEMPT_TIMEOUT_MS is aborted and retried
   once on a fresh fetch, still bounded by the caller's own signal.

   Deliberately narrow:
     - GET/HEAD only (PostgREST reads are idempotent; RPCs/writes are POST
       and must never be replayed).
     - Only requests that carry a caller signal, i.e. reads that already
       opted into the bounded-read contract via `.abortSignal(...)`.
       Unbounded calls (cron sweeps, admin) keep their current behaviour.
     - The attempt timer stops once headers arrive; a slow body read is
       governed by the caller signal alone, never by the attempt timer.
   Trade-off: a genuinely slow read (> 2.5 s to first byte) now costs a
   second request and may exhaust the budget where it previously squeaked
   through. At the observed latency profile that is a rare edge; a stall
   is the common failure.
   ============================================================ */

/** Time to first response headers before an attempt is treated as stalled. */
export const STALL_ATTEMPT_TIMEOUT_MS = 2500;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Internal marker: the attempt timer (not the caller) aborted the fetch. */
class StalledAttemptError extends Error {
  constructor(ms: number) {
    super(`no response headers within ${ms}ms`);
    this.name = 'StalledAttemptError';
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

function requestPath(input: RequestInfo | URL): string {
  try {
    const href = input instanceof Request ? input.url : String(input);
    // Path only — the query string carries filter values, not useful in logs.
    return new URL(href).pathname;
  } catch {
    return '(unparseable url)';
  }
}

async function attemptOnce(
  baseFetch: FetchFn,
  input: RequestInfo | URL,
  init: RequestInit,
  callerSignal: AbortSignal,
  attemptTimeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  // Linked for the whole life of the request (including the body read that
  // happens after this function returns), so a caller timeout still cancels.
  if (callerSignal.aborted) controller.abort(callerSignal.reason);
  else callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true });

  let stalled = false;
  const timer = setTimeout(() => {
    stalled = true;
    controller.abort(new StalledAttemptError(attemptTimeoutMs));
  }, attemptTimeoutMs);
  try {
    return await baseFetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (stalled && !callerSignal.aborted) throw new StalledAttemptError(attemptTimeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the `global.fetch` for a Supabase client. `baseFetch` is injectable
 * for tests; it defaults to a late-bound `globalThis.fetch` (never a stored
 * reference — an unbound `fetch` can throw "Illegal invocation").
 */
export function createStallRetryFetch(
  baseFetch: FetchFn = (input, init) => globalThis.fetch(input, init),
  attemptTimeoutMs: number = STALL_ATTEMPT_TIMEOUT_MS,
): FetchFn {
  return async (input, init) => {
    const callerSignal = init?.signal ?? undefined;
    const method = requestMethod(input, init);
    if (!callerSignal || (method !== 'GET' && method !== 'HEAD')) {
      return baseFetch(input, init);
    }
    try {
      return await attemptOnce(baseFetch, input, init ?? {}, callerSignal, attemptTimeoutMs);
    } catch (err) {
      if (!(err instanceof StalledAttemptError) || callerSignal.aborted) throw err;
      console.warn('[supabase-stall-retry] attempt stalled; retrying once', {
        method,
        path: requestPath(input),
        attemptTimeoutMs,
      });
      return baseFetch(input, { ...init, signal: callerSignal });
    }
  };
}
