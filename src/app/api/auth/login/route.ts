import { NextResponse } from 'next/server';
import { resolveAuthEnv, applyAuthAntiCacheHeaders } from '@/lib/auth/session';
import { createAuthServerClient, type AuthCookie } from '@/lib/auth/supabase-server';
import { AUTH_NEXT_COOKIE, sanitizeNextPath } from '@/lib/auth/redirects';
import { createAuthRateLimiter } from '@/lib/auth/rate-limit';
import { getClientIp } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const authRateLimiter = createAuthRateLimiter();
// x-forwarded-for is spoofable off-Cloudflare, so only trust it outside production.
const TRUST_FORWARDED_IP = process.env.NODE_ENV !== 'production';

/**
 * POST /api/auth/login — start an OAuth sign-in (plain form POST, zero client JS).
 * Body (form fields): `provider` ∈ {google, apple}; optional `next` (internal
 * path to return to after the callback — URL-parser sanitized, then stashed in
 * a short-lived httpOnly cookie).
 *
 * Fail-closed: 404 unless SUPABASE_PUBLISHABLE_KEY is configured. POST-only +
 * rate-limited (login-CSRF resistant). PKCE: signInWithOAuth generates the
 * code verifier locally and our cookie adapter persists it httpOnly; the
 * response is a 303 to the provider's authorize URL via Supabase.
 */
export async function POST(req: Request) {
  const authEnv = resolveAuthEnv();
  if (!authEnv) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Throttle before any work (clone of the /api/returns limiter pattern). In
  // prod a missing IP shares one throttled 'unknown' bucket; in dev fail open.
  const clientIp = getClientIp(req, { trustForwarded: TRUST_FORWARDED_IP })?.trim() || null;
  const rateKey = clientIp ?? (TRUST_FORWARDED_IP ? null : 'unknown');
  const rate = authRateLimiter.allow(rateKey);
  if (!rate.ok) {
    console.warn('auth login: rate_limited', { hasIp: Boolean(clientIp) });
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const provider = form.get('provider');
  if (provider !== 'google' && provider !== 'apple') {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const next = sanitizeNextPath(form.get('next'));

  const setCookies: AuthCookie[] = [];
  const supabase = createAuthServerClient(authEnv, {
    cookieHeader: req.headers.get('cookie'),
    onSetCookies: (cookies) => setCookies.push(...cookies),
  });

  // On the Worker the public origin comes from env (immune to Host spoofing);
  // in plain-node dev/E2E fall back to the request's own origin so localhost
  // round-trips work. Either way Supabase's redirect allowlist has final say.
  const origin = authEnv.workerOrigin ?? new URL(req.url).origin;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${origin}/api/auth/callback`, skipBrowserRedirect: true },
  });
  if (error || !data?.url) {
    console.error('auth login: signInWithOAuth failed', error);
    return NextResponse.json({ error: 'auth_failed' }, { status: 500 });
  }

  const response = NextResponse.redirect(data.url, 303);
  for (const cookie of setCookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  if (next) {
    response.cookies.set(AUTH_NEXT_COOKIE, next, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
  }
  applyAuthAntiCacheHeaders(response.headers);
  return response;
}
