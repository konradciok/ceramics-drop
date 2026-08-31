/* ============================================================
   Supabase call bounding — timeout + fallback helper.
   ------------------------------------------------------------
   The Supabase JS client makes an HTTP call per query with no built-in
   timeout. If the underlying fetch stalls (network jitter, a slow
   PostgREST response) rather than rejecting, an unbounded `await` blocks
   until the Workers runtime's own CPU/wall-clock limit kills the whole
   invocation — surfacing as a platform-level 5xx with zero application
   error and zero Sentry signal, since the kill happens before any JS
   catch can run. `.abortSignal(supabaseTimeout())` on every Supabase
   query-builder call converts a possible-infinite hang into a normal,
   catchable rejection well inside any platform limit.
   ============================================================ */
import * as Sentry from '@sentry/nextjs';

/** Per-call timeout: generous headroom over normal PostgREST latency
 *  (tens-hundreds of ms) while staying well under platform limits even
 *  when several calls in one render are sequential, not parallel. */
export const SUPABASE_QUERY_TIMEOUT_MS = 5000;

/** Pass to `.abortSignal()` on a Supabase query builder call. */
export function supabaseTimeout(ms: number = SUPABASE_QUERY_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Run `fn`, returning `fallback` (and reporting to Sentry) on any failure —
 * including a timeout, which `.abortSignal(supabaseTimeout())` at the call
 * sites converts into a normal rejection this can catch. Use at the outer
 * "loader" boundary that already has a defined degraded value; low-level
 * repository readers should keep throwing on error, same as today.
 */
export async function readWithFallback<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  extra?: Record<string, unknown>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[supabase-timeout] ${label} failed; using fallback`, extra, err);
    Sentry.captureException(err, { tags: { supabaseTimeoutLabel: label }, extra });
    return fallback;
  }
}
