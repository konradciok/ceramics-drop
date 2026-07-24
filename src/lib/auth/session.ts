/* ============================================================
   Customer-account sessions (Supabase Auth, server-only).
   ------------------------------------------------------------
   Sessions live in httpOnly `sb-<ref>-auth-token` cookies written exclusively
   by route handlers / middleware (src/lib/auth/supabase-server.ts). This module
   is the READ side: it reassembles the chunked cookie and verifies the access
   token locally with jose against the project JWKS — a near-copy of the admin
   gate in src/lib/admin/access.ts, including the module-level JWKS cache.
   Supabase itself is contacted only to mint/refresh/revoke sessions.

   Local verification is a fast path bounded by the access-token TTL (1 h): it
   cannot observe server-side revocation, the same stateless-JWT acceptance the
   Cloudflare Access admin gate already makes. Fail-closed everywhere: any
   error ⇒ signed-out, never a 500 — the storefront and checkout must never
   depend on auth availability.

   Feature gate: the PRESENCE of SUPABASE_PUBLISHABLE_KEY enables accounts
   (unset ⇒ auth routes 404, /konto renders "unavailable", middleware and
   checkout skip session work entirely).
   ============================================================ */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { combineChunks, parseCookieHeader, stringFromBase64URL } from '@supabase/ssr';
import { getWorkerOrigin } from '@/lib/site.server';

export type SessionUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type AuthEnv = {
  supabaseUrl: string;
  publishableKey: string;
  /** Public origin for OAuth redirects when running on the Worker (null in plain-node dev/E2E — callers fall back to the request origin). */
  workerOrigin: string | null;
};

type AuthEnvSource = Pick<CloudflareEnv, 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY' | 'WORKER_ORIGIN'>;

/**
 * Resolve auth config from the Workers env, falling back to process.env for
 * contexts without request ALS (unit tests, hermetic `next start` E2E).
 * Returns null unless both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set —
 * the fail-closed feature gate.
 */
export function resolveAuthEnv(): AuthEnv | null {
  let env: AuthEnvSource;
  let onWorker = true;
  try {
    env = getCloudflareContext().env;
  } catch {
    env = process.env as unknown as AuthEnvSource;
    onWorker = false;
  }
  const supabaseUrl = env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !publishableKey) return null;
  return {
    supabaseUrl,
    publishableKey,
    workerOrigin: onWorker ? getWorkerOrigin(env) : null,
  };
}

/** Feature flag: customer accounts are enabled iff the publishable key is set. */
export function authEnabled(): boolean {
  return resolveAuthEnv() !== null;
}

/** Supabase session cookie name — mirrors supabase-js's default storage key. */
export function authCookieName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}

/** Matches the session cookie and its chunked `.0`, `.1`, … variants (any project ref). */
export const SB_AUTH_COOKIE_RE = /^sb-.+-auth-token(?:\.\d+)?$/;

// ── Anti-cache headers (§7 of the plan) ───────────────────────────────────────
// Every response that writes auth cookies (auth routes, middleware refresh,
// checkout inline refresh) carries the full set per Supabase SSR guidance —
// not just the house `private, no-store`.
export const AUTH_ANTI_CACHE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

export function applyAuthAntiCacheHeaders(headers: Headers): void {
  for (const [key, value] of Object.entries(AUTH_ANTI_CACHE_HEADERS)) {
    headers.set(key, value);
  }
}

// ── Local JWT verification ────────────────────────────────────────────────────

// Cached module-level JWKS fetcher — keyed by project URL so restarts pick up
// a fresh set while normal requests reuse the cached instance (access.ts pattern).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(supabaseUrl: string): JWTVerifyGetKey {
  if (!jwksCache.has(supabaseUrl)) {
    const url = new URL('/auth/v1/.well-known/jwks.json', supabaseUrl);
    jwksCache.set(supabaseUrl, createRemoteJWKSet(url));
  }
  return jwksCache.get(supabaseUrl)!;
}

/** Seconds of remaining token life below which the middleware refreshes early. */
export const SESSION_REFRESH_LEEWAY_SECONDS = 60;

export type SessionRead = {
  user: SessionUser | null;
  /** An `sb-*-auth-token` cookie (or chunk) for this project exists. */
  hasAuthCookie: boolean;
  /** Cookie holds a refresh token and the access token is expired/expiring/unverifiable — worth one network refresh. */
  needsRefresh: boolean;
};

const SIGNED_OUT: SessionRead = { user: null, hasAuthCookie: false, needsRefresh: false };

type StoredSession = { access_token?: unknown; refresh_token?: unknown };

/** Decode the (possibly `base64-`-prefixed) cookie value into the stored session JSON. */
function decodeSessionCookie(value: string): StoredSession | null {
  try {
    const json = value.startsWith('base64-') ? stringFromBase64URL(value.slice('base64-'.length)) : value;
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

async function verifyAccessToken(
  accessToken: string,
  authEnv: AuthEnv,
  opts?: { jwks?: JWTVerifyGetKey; now?: number },
): Promise<{ user: SessionUser; expiresInSeconds: number } | null> {
  try {
    const jwks = opts?.jwks ?? getJwks(authEnv.supabaseUrl);
    const { payload } = await jwtVerify(accessToken, jwks, {
      issuer: `${authEnv.supabaseUrl}/auth/v1`,
      audience: 'authenticated',
      currentDate: opts?.now !== undefined ? new Date(opts.now) : undefined,
    });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    const metadata = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      typeof metadata.full_name === 'string' && metadata.full_name
        ? metadata.full_name
        : typeof metadata.name === 'string' && metadata.name
          ? metadata.name
          : null;
    const nowSecs = Math.floor((opts?.now ?? Date.now()) / 1000);
    return {
      user: {
        id: payload.sub,
        email: typeof payload.email === 'string' && payload.email ? payload.email : null,
        name,
      },
      expiresInSeconds: typeof payload.exp === 'number' ? payload.exp - nowSecs : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Core session read from a cookie-chunk lookup. Pure w.r.t. the environment
 * (authEnv + optional jwks are injected), so it unit-tests without network.
 */
export async function readSessionFromChunks(
  getChunk: (name: string) => string | undefined,
  authEnv: AuthEnv,
  opts?: { jwks?: JWTVerifyGetKey; now?: number },
): Promise<SessionRead> {
  const cookieName = authCookieName(authEnv.supabaseUrl);
  const hasAuthCookie =
    getChunk(cookieName) !== undefined || getChunk(`${cookieName}.0`) !== undefined;
  if (!hasAuthCookie) return SIGNED_OUT;

  const combined = await combineChunks(cookieName, (name) => getChunk(name));
  const session = combined ? decodeSessionCookie(combined) : null;
  if (!session) return { user: null, hasAuthCookie: true, needsRefresh: false };

  // Only a stored refresh token makes a network refresh worth attempting.
  const canRefresh = typeof session.refresh_token === 'string' && session.refresh_token.length > 0;
  if (typeof session.access_token !== 'string' || !session.access_token) {
    return { user: null, hasAuthCookie: true, needsRefresh: canRefresh };
  }

  const verified = await verifyAccessToken(session.access_token, authEnv, opts);
  if (!verified) {
    // Expired, expiring, or signed with a rotated-away key — the refresh path
    // (authoritative, server-side) sorts real sessions from garbage.
    return { user: null, hasAuthCookie: true, needsRefresh: canRefresh };
  }
  return {
    user: verified.user,
    hasAuthCookie: true,
    needsRefresh: canRefresh && verified.expiresInSeconds < SESSION_REFRESH_LEEWAY_SECONDS,
  };
}

/** Session read from a raw `cookie` request header (checkout fast path, middleware, unit tests). */
export async function readSessionFromCookieHeader(
  cookieHeader: string | null,
  authEnv: AuthEnv,
  opts?: { jwks?: JWTVerifyGetKey; now?: number },
): Promise<SessionRead> {
  const chunks = new Map<string, string>();
  for (const { name, value } of parseCookieHeader(cookieHeader ?? '')) {
    if (typeof value === 'string') chunks.set(name, value);
  }
  return readSessionFromChunks((name) => chunks.get(name), authEnv, opts);
}

/**
 * Verified session user for RSC account pages (via next/headers). Local-only:
 * an expired-but-refreshable session reads as signed-out here — the middleware
 * owns the `/konto` refresh, so by render time the cookie is already rotated.
 * Fail-closed: any error ⇒ null, never a 500.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const authEnv = resolveAuthEnv();
    if (!authEnv) return null;
    const { cookies } = await import('next/headers');
    const store = await cookies();
    const read = await readSessionFromChunks((name) => store.get(name)?.value, authEnv);
    return read.user;
  } catch {
    return null;
  }
}

// ── Refresh path (middleware + checkout inline refresh) ───────────────────────

export type SessionResolution = {
  user: SessionUser | null;
  /** Rotated session cookies to copy onto the outgoing response (empty when no refresh ran). */
  setCookies: import('./supabase-server').AuthCookie[];
};

/**
 * Resolve the session from a request cookie header, refreshing via Supabase
 * when the fast local verify can't produce a user (expired / expiring / key
 * rotation). Callers MUST forward `setCookies` onto their response (plus the
 * anti-cache headers) or the rotated refresh token is lost and the browser's
 * copy turns stale. On any failure the result degrades to signed-out — auth
 * must never block payment or a page render.
 *
 * With `timeoutMs` set, the WHOLE resolution (JWKS fetch, cookie parse,
 * network refresh) races a hard deadline and degrades to signed-out when it
 * fires — checkout uses this so a Supabase Auth stall can never block payment.
 * A refresh that completes after the deadline forfeits its rotated cookies:
 * the browser keeps its previous refresh token (tolerated by Supabase's
 * rotation reuse window); worst case that session signs in again later.
 */
export async function resolveSessionWithRefresh(
  cookieHeader: string | null,
  opts?: { jwks?: JWTVerifyGetKey; now?: number; timeoutMs?: number },
): Promise<SessionResolution> {
  const none: SessionResolution = { user: null, setCookies: [] };
  const work = (async (): Promise<SessionResolution> => {
    try {
      const authEnv = resolveAuthEnv();
      if (!authEnv) return none;

      const read = await readSessionFromCookieHeader(cookieHeader, authEnv, opts);
      if (read.user && !read.needsRefresh) return { user: read.user, setCookies: [] };
      if (!read.needsRefresh) return none;

      // One network refresh; rotated cookies are buffered for the caller.
      const { createAuthServerClient } = await import('./supabase-server');
      const setCookies: SessionResolution['setCookies'] = [];
      const supabase = createAuthServerClient(authEnv, {
        cookieHeader,
        onSetCookies: (cookies) => setCookies.push(...cookies),
      });
      const { data, error } = await supabase.auth.getUser();
      if (error || !data?.user?.id) return { user: null, setCookies };
      const metadata = (data.user.user_metadata ?? {}) as Record<string, unknown>;
      return {
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          name:
            typeof metadata.full_name === 'string' && metadata.full_name
              ? metadata.full_name
              : typeof metadata.name === 'string' && metadata.name
                ? metadata.name
                : null,
        },
        setCookies,
      };
    } catch {
      return none;
    }
  })();

  const timeoutMs = opts?.timeoutMs;
  if (timeoutMs === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SessionResolution>((resolve) => {
    timer = setTimeout(() => resolve(none), timeoutMs);
  });
  try {
    // `work` never rejects (fail-closed above), so the race can only resolve.
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
