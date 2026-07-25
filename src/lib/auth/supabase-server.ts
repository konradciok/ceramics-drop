/* ============================================================
   Supabase Auth server client factory (customer accounts).
   ------------------------------------------------------------
   The ONLY place a Supabase client is built with the publishable key — and it
   is server-only: callers pass the request's cookie header in and receive the
   library's cookie writes through a buffered sink, which they copy onto their
   outgoing response themselves (route handlers onto redirects/JSON, middleware
   onto the i18n response). Implementing BOTH cookie-adapter callbacks is part
   of the @supabase/ssr contract — omitting setAll would make refreshed tokens
   silently vanish (random logouts).

   Every write pins the hardened attributes (httpOnly + Secure + SameSite=Lax,
   path=/) — stricter than the library's browser-oriented defaults, safe
   because no browser JS ever needs to read the session.
   ============================================================ */
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthEnv } from './session';

// `Secure` only in production — mirrors COOKIE_SECURE in src/middleware.ts so
// local `next dev`/`next start` over plain http keeps its cookies.
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

/** Cookie attributes accepted by both NextResponse.cookies.set and Set-Cookie serializers. */
export type AuthCookieOptions = {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: 'lax' | 'strict' | 'none';
  secure?: boolean;
};

export type AuthCookie = { name: string; value: string; options: AuthCookieOptions };

/** Force the pinned attribute set, keeping the library's lifetime fields (maxAge/expires drive deletion). */
function pinCookieOptions(options: Record<string, unknown> | undefined): AuthCookieOptions {
  const lifetime: AuthCookieOptions = {};
  if (typeof options?.maxAge === 'number') lifetime.maxAge = options.maxAge;
  if (options?.expires instanceof Date) lifetime.expires = options.expires;
  return { ...lifetime, httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' };
}

/**
 * Build a Supabase Auth client bound to a request's cookies, with all cookie
 * writes buffered through `onSetCookies` (already pinned httpOnly/Secure/Lax).
 * The caller owns applying them to its response — see module doc.
 */
export function createAuthServerClient(
  authEnv: AuthEnv,
  io: { cookieHeader: string | null; onSetCookies: (cookies: AuthCookie[]) => void },
): SupabaseClient {
  return createServerClient(authEnv.supabaseUrl, authEnv.publishableKey, {
    cookieEncoding: 'base64url',
    cookieOptions: { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' },
    cookies: {
      getAll: () => parseRequestCookies(io.cookieHeader),
      setAll: (cookies) => {
        io.onSetCookies(
          cookies.map(({ name, value, options }) => ({
            name,
            value,
            options: pinCookieOptions(options as Record<string, unknown> | undefined),
          })),
        );
      },
    },
  });
}

function parseRequestCookies(cookieHeader: string | null): { name: string; value: string }[] {
  if (!cookieHeader) return [];
  // Minimal RFC6265 request-cookie parse with decode — same semantics as the
  // library's parseCookieHeader, kept local so the shape is always {name,value}.
  return cookieHeader
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return null;
      const name = pair.slice(0, eq).trim();
      if (!name) return null;
      const raw = pair.slice(eq + 1).trim();
      let value: string;
      try {
        value = decodeURIComponent(raw);
      } catch {
        value = raw;
      }
      return { name, value };
    })
    .filter((c): c is { name: string; value: string } => c !== null);
}
