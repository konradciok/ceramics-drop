/**
 * Request/response hardening for the admin surface (`/admin`, `/api/admin`),
 * applied by `worker.ts` after the Cloudflare Access JWT check passes
 * (`verifyAdminAccess` in ./access.ts). Pure, so the matrix is unit-testable.
 *
 * - `checkAdminMutation` — CSRF gate (audit AD-1). The Access cookie rides
 *   along on a cross-site top-level form POST, and the admin routes parse JSON
 *   regardless of Content-Type, so without this a page on another site could
 *   auto-submit a `text/plain` form that creates a 100% promo, refunds an order
 *   or ends a drop. Same Origin rule as `src/app/api/auth/signout/route.ts`,
 *   plus Fetch Metadata and a Content-Type allowlist that forces a CORS
 *   preflight (which no admin route answers) for any cross-origin browser write.
 * - `withAdminSecurityHeaders` — nosniff + anti-framing (audit ED-01, admin
 *   part): stops clickjacking an operator into an admin action button.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ADMIN_API_RE = /^\/api\/admin(\/|$)/;
/** Raw-body upload route (HomeHeroEditor sends `content-type: file.type`). */
const MEDIA_UPLOAD_RE = /^\/api\/admin\/content\/media\/?$/;

export type AdminMutationCheck =
  | { ok: true }
  | { ok: false; status: 403; error: 'forbidden' }
  | { ok: false; status: 415; error: 'unsupported_media_type' };

function mediaTypeEssence(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Decide whether a request to an admin path may proceed. Safe methods always
 * pass. For anything else:
 *   1. `Sec-Fetch-Site`, when present, must be `same-origin`;
 *   2. `Origin`, when present, must equal the request URL's origin;
 *      (both absent = non-browser client — browsers always send at least one
 *      on a cross-site POST, so that case is allowed);
 *   3. on `/api/admin/*`, the Content-Type must be `application/json`, or
 *      `image/*` / `video/*` on the media upload route — none of which a
 *      cross-site form or no-cors fetch can send without a preflight.
 */
export function checkAdminMutation(request: Request): AdminMutationCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const url = new URL(request.url);

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite.trim().toLowerCase() !== 'same-origin') {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== url.origin) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  if (ADMIN_API_RE.test(url.pathname)) {
    const type = mediaTypeEssence(request.headers.get('content-type'));
    const allowed = MEDIA_UPLOAD_RE.test(url.pathname)
      ? type.startsWith('image/') || type.startsWith('video/')
      : type === 'application/json';
    if (!allowed) return { ok: false, status: 415, error: 'unsupported_media_type' };
  }

  return { ok: true };
}

/**
 * Copy `response` (its headers may be immutable, e.g. `Response.redirect`) and
 * add the admin security headers. `X-Content-Type-Options` and
 * `X-Frame-Options` are always set; `Content-Security-Policy: frame-ancestors
 * 'none'` and `Referrer-Policy` only when the response has none, so a route's
 * own policy is never clobbered.
 */
export function withAdminSecurityHeaders(response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  if (!res.headers.has('Content-Security-Policy')) {
    res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  }
  if (!res.headers.has('Referrer-Policy')) {
    res.headers.set('Referrer-Policy', 'same-origin');
  }
  return res;
}
