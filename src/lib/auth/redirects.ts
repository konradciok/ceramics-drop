/* ============================================================
   Post-login redirect hygiene (customer accounts).
   ------------------------------------------------------------
   The `next` value a sign-in form submits is attacker-influencable, so it is
   sanitized with the URL PARSER, not a regex — a naive "starts with a single
   slash" check would pass "/\evil.example", which browsers normalize into a
   protocol-relative external redirect. Enforced at /api/auth/login AND
   re-checked when the stashed cookie value is consumed at /api/auth/callback
   (open-redirect proof).
   ============================================================ */
import { SITE_URL } from '@/lib/site';

/** Short-lived httpOnly cookie carrying the sanitized post-login path between /api/auth/login and /api/auth/callback. */
export const AUTH_NEXT_COOKIE = 'sb-auth-next';

/** One-shot, client-readable cookie the auth callback sets so the browser can
 *  emit a login/sign_up analytics event exactly once (AuthAnalytics.tsx). NOT
 *  httpOnly — the client must read it. Value: `<login|sign_up>:<method>:<userId>`. */
export const AUTH_EVENT_COOKIE = 'acc_auth_event';

/** Locale-less default landing page after auth actions. */
export const KONTO_PATH = '/konto';

/** Backslashes (URL-normalized into "//") and C0 control characters are never valid in an internal path. */
function hasForbiddenChars(value: string): boolean {
  if (value.includes('\\')) return true;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * Sanitize a requested post-login path down to a same-site `pathname?search`.
 * Returns null for anything that is not provably an internal path: absolute
 * URLs on other origins, protocol-relative `//host`, backslash smuggling,
 * control characters, or unparsable input.
 */
export function sanitizeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (!candidate || hasForbiddenChars(candidate)) return null;
  let url: URL;
  try {
    // Resolving against SITE_URL turns relative paths absolute; absolute
    // inputs keep their own origin and fail the check below.
    url = new URL(candidate, SITE_URL);
  } catch {
    return null;
  }
  if (url.origin !== new URL(SITE_URL).origin) return null;
  // Only ever redirect to a path + query on the current origin (hash dropped).
  return `${url.pathname}${url.search}`;
}
