/* ============================================================
   Request-scoped degradation flag — cold-fail-closed → HTTP 503
   ------------------------------------------------------------
   When a cold isolate cannot read the ceramic catalogue, products.ts falls
   back to a fail-closed projection (nothing public — see
   catalog/last-known-good.ts). That keeps withdrawn pieces off the site, but
   it also makes every ceramic PDP a real 404 and drops all ceramics from the
   sitemap. Crawlers treat 404 as "gone" — production telemetry showed
   PetalBot and YandexBot receiving exactly that during transient Supabase
   connection stalls. A 503 with Retry-After tells them to come back instead.

   Next's App Router cannot set an arbitrary status from a page, so the
   decision is made in worker.ts around the OpenNext handler:
     1. worker.ts opens a per-request scope (request-degradation-scope.ts,
        AsyncLocalStorage).
     2. products.ts calls markCeramicCatalogColdFailClosed() when it serves
        the cold-fail-closed tier.
     3. worker.ts passes the finished response through
        applyCatalogDegradation(), which turns the affected responses into 503.

   The ALS instance lives on globalThis under a Symbol.for() key because
   worker.ts (bundled by wrangler) and the Next server code (bundled by
   webpack) get separate copies of this module; a module-scope instance would
   not be shared between them. This file stays free of `node:` imports
   because client components import products.ts.
   ============================================================ */

export const REQUEST_DEGRADATION_KEY = Symbol.for('ceramics-drop.request-degradation');

export interface RequestDegradation {
  /** The ceramic catalogue was served from the cold-fail-closed tier during this request. */
  ceramicCatalogColdFailClosed: boolean;
}

interface DegradationStore {
  getStore(): RequestDegradation | undefined;
}

function currentDegradation(): RequestDegradation | undefined {
  const store = (globalThis as Record<symbol, unknown>)[REQUEST_DEGRADATION_KEY] as DegradationStore | undefined;
  return store?.getStore();
}

/** Flag the current request as served from the cold-fail-closed catalogue. A no-op outside a scope (tests, build). */
export function markCeramicCatalogColdFailClosed(): void {
  const state = currentDegradation();
  if (state) state.ceramicCatalogColdFailClosed = true;
}

/** Seconds a client should wait before retrying — the stalls we see clear within seconds. */
export const DEGRADED_RETRY_AFTER_SECONDS = 30;

const SITEMAP_PATH = '/sitemap.xml';

const UNAVAILABLE_HTML = `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chwilowo niedostępne · Temporarily unavailable</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">
<h1>Chwilowo niedostępne</h1><p>Spróbuj ponownie za chwilę.</p>
<p lang="en">Temporarily unavailable — please try again in a moment.</p>
</body></html>`;

/**
 * Turn a response into 503 + Retry-After when it was produced from the
 * cold-fail-closed catalogue and would otherwise lie to a crawler:
 *   - any 404 (a ceramic PDP — or any other lookup — that only 404s because
 *     the catalogue was unavailable), and
 *   - the sitemap (it would be served without a single ceramic URL).
 * Everything else (e.g. a collection page that still renders) is untouched.
 * The 404 status is decided before Next streams the body (the PDP route group
 * has no loading.tsx), so the flag is always set by the time this runs.
 */
export function applyCatalogDegradation(
  request: Request,
  response: Response,
  state: RequestDegradation | undefined,
): Response {
  if (!state?.ceramicCatalogColdFailClosed) return response;
  if (request.method !== 'GET' && request.method !== 'HEAD') return response;
  const isSitemap = new URL(request.url).pathname === SITEMAP_PATH;
  if (response.status !== 404 && !isSitemap) return response;

  response.body?.cancel().catch(() => {});
  return new Response(request.method === 'HEAD' ? null : UNAVAILABLE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(DEGRADED_RETRY_AFTER_SECONDS),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
