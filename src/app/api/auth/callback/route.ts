import { NextResponse } from 'next/server';
import { resolveAuthEnv, applyAuthAntiCacheHeaders } from '@/lib/auth/session';
import { createAuthServerClient, type AuthCookie } from '@/lib/auth/supabase-server';
import { AUTH_NEXT_COOKIE, KONTO_PATH, sanitizeNextPath } from '@/lib/auth/redirects';
import { linkOrdersToUser } from '@/lib/account/link-orders';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/callback — OAuth return leg. The provider round-trip
 * terminates at Supabase's /auth/v1/callback (which absorbs Apple's cross-site
 * form_post); Supabase then sends the browser here with a clean top-level GET
 * `?code=`, so SameSite=Lax httpOnly cookies flow without special-casing.
 *
 * exchangeCodeForSession binds the code to the PKCE verifier cookie and mints
 * the session (written httpOnly via the cookie adapter). Afterwards the
 * best-effort backfill links this user's past guest orders by verified email —
 * try/caught, never blocks the redirect. Provider `?error` responses and
 * failed exchanges never mint session cookies and land on /konto?auth_error=1.
 */
export async function GET(req: Request) {
  const authEnv = resolveAuthEnv();
  if (!authEnv) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const url = new URL(req.url);
  const cookieHeader = req.headers.get('cookie');
  // Re-sanitize the stashed value on consumption — the cookie is client-side
  // state and must survive the same open-redirect scrutiny as the form field.
  const storedNext = sanitizeNextPath(readCookie(cookieHeader, AUTH_NEXT_COOKIE));

  const finish = (path: string, setCookies: AuthCookie[]) => {
    const response = NextResponse.redirect(new URL(path, url.origin), 303);
    for (const cookie of setCookies) {
      response.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    // Consume the next-path cookie in every outcome.
    response.cookies.set(AUTH_NEXT_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    applyAuthAntiCacheHeaders(response.headers);
    return response;
  };

  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) {
    // Provider declined / user cancelled / malformed return — no cookies minted.
    return finish(`${KONTO_PATH}?auth_error=1`, []);
  }

  const setCookies: AuthCookie[] = [];
  const supabase = createAuthServerClient(authEnv, {
    cookieHeader,
    onSetCookies: (cookies) => setCookies.push(...cookies),
  });
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data?.user?.id) {
    console.error('auth callback: code exchange failed', error);
    // Forward only the library's cleanup writes (e.g. PKCE verifier removal).
    return finish(`${KONTO_PATH}?auth_error=1`, setCookies);
  }

  // Backfill-on-login: sweep unclaimed guest orders for this verified email.
  // Best-effort — a DB hiccup must never break the login redirect.
  try {
    await linkOrdersToUser(data.user);
  } catch (err) {
    console.error('auth callback: order backfill failed for user', data.user.id, err);
  }

  return finish(storedNext ?? KONTO_PATH, setCookies);
}

/** Read a single cookie value from a raw request cookie header. */
function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
