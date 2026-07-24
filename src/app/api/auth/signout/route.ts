import { NextResponse } from 'next/server';
import { resolveAuthEnv, applyAuthAntiCacheHeaders } from '@/lib/auth/session';
import { createAuthServerClient, type AuthCookie } from '@/lib/auth/supabase-server';
import { sanitizeNextPath } from '@/lib/auth/redirects';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/signout — plain form POST. Revokes the session server-side
 * (`scope: 'local'` — this session family only) and deletes the cookies via
 * the adapter, then 303s to the form's sanitized `next` path (the localized
 * account page — a signed-out `/es/konto` must not land on the Polish
 * homepage), falling back to `/`. Cookie deletion is immediate for this
 * browser; an already-issued access token verified locally elsewhere stays
 * valid until `exp` (≤1 h) — the documented stateless-JWT trade-off (plan §9).
 */
export async function POST(req: Request) {
  const authEnv = resolveAuthEnv();
  if (!authEnv) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Origin check (CSRF hardening for the plain form POST): browsers send
  // Origin on cross-site POSTs; when present it must match this request's host.
  const origin = req.headers.get('origin');
  const selfOrigin = new URL(req.url).origin;
  if (origin && origin !== selfOrigin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Same open-redirect posture as /api/auth/login: the form's `next` is
  // attacker-influencable, so only a sanitizer-proven internal path is used.
  let nextPath: string | null = null;
  try {
    nextPath = sanitizeNextPath((await req.formData()).get('next'));
  } catch {
    nextPath = null; // no/invalid form body — fall back to home
  }

  const setCookies: AuthCookie[] = [];
  const supabase = createAuthServerClient(authEnv, {
    cookieHeader: req.headers.get('cookie'),
    onSetCookies: (cookies) => setCookies.push(...cookies),
  });
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) {
    // Still clear cookies + redirect — a revocation hiccup must not trap the
    // user signed-in; the refresh token dies with the cookie for this browser.
    console.error('auth signout: revoke failed', error);
  }

  const response = NextResponse.redirect(new URL(nextPath ?? '/', selfOrigin), 303);
  for (const cookie of setCookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  applyAuthAntiCacheHeaders(response.headers);
  return response;
}
