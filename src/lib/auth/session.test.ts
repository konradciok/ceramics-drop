import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { createChunks, stringToBase64URL } from '@supabase/ssr';
import {
  AUTH_ANTI_CACHE_HEADERS,
  CHECKOUT_AUTH_REFRESH_TIMEOUT_MS,
  SB_AUTH_COOKIE_RE,
  applyAuthAntiCacheHeaders,
  authCookieName,
  readSessionFromCookieHeader,
  resolveSessionWithRefresh,
  type AuthEnv,
} from './session';

const SUPABASE_URL = 'https://testref.supabase.co';
const AUTH_ENV: AuthEnv = { supabaseUrl: SUPABASE_URL, publishableKey: 'sb_publishable_test', workerOrigin: null };
const COOKIE_NAME = authCookieName(SUPABASE_URL);
const USER_ID = '5f1c1862-2f31-4bd0-9caa-4c5a0e7dc70d';

// Locally-signed ES256 tokens verified through an injected local JWKS — the
// same asymmetric-signing shape the Supabase project uses in production.
let jwks: JWTVerifyGetKey;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let signToken: (claims?: Record<string, unknown>, opts?: { expiresInSeconds?: number }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  signingKey = privateKey;
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
  signToken = async (claims = {}, opts = {}) => {
    const nowSecs = Math.floor(Date.now() / 1000);
    return new SignJWT({
      email: 'buyer@example.com',
      user_metadata: { full_name: 'Test Buyer' },
      role: 'authenticated',
      ...claims,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(USER_ID)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt(nowSecs)
      .setExpirationTime(nowSecs + (opts.expiresInSeconds ?? 3600))
      .sign(privateKey);
  };
});

/**
 * Mint the cookie header the way @supabase/ssr itself writes sessions:
 * base64url-encoded JSON behind the `base64-` prefix, chunked with the
 * library's own createChunks — so a library-side format drift fails these
 * tests loudly instead of production silently.
 */
function cookieHeaderFor(session: Record<string, unknown>, opts?: { chunkSize?: number }): string {
  const value = `base64-${stringToBase64URL(JSON.stringify(session))}`;
  const chunks = createChunks(COOKIE_NAME, value, opts?.chunkSize);
  return chunks.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');
}

function sessionFor(
  accessToken: string,
  refreshToken: string | null = 'rt_test',
  expiresAtSecs?: number,
): Record<string, unknown> {
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    // supabase-js validates the stored session shape (expires_at included)
    // before using it — the real @supabase/ssr cookie always carries it.
    expires_at: expiresAtSecs ?? Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refreshToken ?? undefined,
    user: { id: USER_ID },
  };
}

describe('authCookieName', () => {
  it('derives sb-<ref>-auth-token from the project URL (supabase-js parity)', () => {
    expect(COOKIE_NAME).toBe('sb-testref-auth-token');
  });
});

describe('SB_AUTH_COOKIE_RE', () => {
  it('matches the session cookie and its chunks, not other sb- cookies', () => {
    expect(SB_AUTH_COOKIE_RE.test('sb-testref-auth-token')).toBe(true);
    expect(SB_AUTH_COOKIE_RE.test('sb-testref-auth-token.0')).toBe(true);
    expect(SB_AUTH_COOKIE_RE.test('sb-testref-auth-token.12')).toBe(true);
    expect(SB_AUTH_COOKIE_RE.test('sb-testref-auth-token-code-verifier')).toBe(false);
    expect(SB_AUTH_COOKIE_RE.test('sb-auth-next')).toBe(false);
    expect(SB_AUTH_COOKIE_RE.test('currency_pref')).toBe(false);
  });
});

describe('applyAuthAntiCacheHeaders', () => {
  it('sets the full anti-cache set on every cookie-writing auth response', () => {
    const headers = new Headers();
    applyAuthAntiCacheHeaders(headers);
    expect(headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate, max-age=0');
    expect(headers.get('Pragma')).toBe('no-cache');
    expect(headers.get('Expires')).toBe('0');
    // Guard the constant itself so route tests asserting via it stay honest.
    expect(Object.keys(AUTH_ANTI_CACHE_HEADERS)).toHaveLength(3);
  });
});

describe('readSessionFromCookieHeader', () => {
  it('returns the verified user for a fresh session', async () => {
    const header = cookieHeaderFor(sessionFor(await signToken()));
    const read = await readSessionFromCookieHeader(header, AUTH_ENV, { jwks });
    expect(read.user).toEqual({ id: USER_ID, email: 'buyer@example.com', name: 'Test Buyer' });
    expect(read.hasAuthCookie).toBe(true);
    expect(read.needsRefresh).toBe(false);
  });

  it('reassembles a chunked cookie (library chunking)', async () => {
    const header = cookieHeaderFor(sessionFor(await signToken()), { chunkSize: 120 });
    expect(header).toContain(`${COOKIE_NAME}.0=`);
    expect(header).toContain(`${COOKIE_NAME}.1=`);
    const read = await readSessionFromCookieHeader(header, AUTH_ENV, { jwks });
    expect(read.user?.id).toBe(USER_ID);
  });

  it('falls back to user_metadata.name and tolerates a missing email', async () => {
    const token = await signToken({ email: undefined, user_metadata: { name: 'Nick Only' } });
    const read = await readSessionFromCookieHeader(cookieHeaderFor(sessionFor(token)), AUTH_ENV, { jwks });
    expect(read.user).toEqual({ id: USER_ID, email: null, name: 'Nick Only' });
  });

  it('flags an expiring (<60s left) session for refresh while still returning the user', async () => {
    const header = cookieHeaderFor(sessionFor(await signToken({}, { expiresInSeconds: 30 })));
    const read = await readSessionFromCookieHeader(header, AUTH_ENV, { jwks });
    expect(read.user?.id).toBe(USER_ID);
    expect(read.needsRefresh).toBe(true);
  });

  it('reads an expired session as signed-out but refresh-worthy', async () => {
    const header = cookieHeaderFor(sessionFor(await signToken({}, { expiresInSeconds: -120 })));
    const read = await readSessionFromCookieHeader(header, AUTH_ENV, { jwks });
    expect(read.user).toBeNull();
    expect(read.hasAuthCookie).toBe(true);
    expect(read.needsRefresh).toBe(true);
  });

  it('never asks for a refresh when the session has no refresh token', async () => {
    const header = cookieHeaderFor(sessionFor(await signToken({}, { expiresInSeconds: -120 }), null));
    const read = await readSessionFromCookieHeader(header, AUTH_ENV, { jwks });
    expect(read.user).toBeNull();
    expect(read.needsRefresh).toBe(false);
  });

  it('rejects a wrong audience (fail-closed, refresh allowed to disambiguate)', async () => {
    // Signed with the REAL key so the audience check is what fails.
    const token = await new SignJWT({ email: 'buyer@example.com' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(USER_ID)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('somewhere-else')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signingKey);
    const read = await readSessionFromCookieHeader(cookieHeaderFor(sessionFor(token)), AUTH_ENV, { jwks });
    expect(read.user).toBeNull();
    expect(read.needsRefresh).toBe(true);
  });

  it('rejects a wrong issuer', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(USER_ID)
      .setIssuer('https://other.supabase.co/auth/v1')
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signingKey);
    const read = await readSessionFromCookieHeader(cookieHeaderFor(sessionFor(token)), AUTH_ENV, { jwks });
    expect(read.user).toBeNull();
  });

  it('rejects a token signed with a different key (signature check)', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(USER_ID)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign((await generateKeyPair('ES256')).privateKey);
    const read = await readSessionFromCookieHeader(cookieHeaderFor(sessionFor(token)), AUTH_ENV, { jwks });
    expect(read.user).toBeNull();
  });

  it('reads a malformed cookie as signed-out without asking for a refresh', async () => {
    const header = `${COOKIE_NAME}=base64-not!valid!`;
    const read = await readSessionFromCookieHeader(header, AUTH_ENV, { jwks });
    expect(read).toEqual({ user: null, hasAuthCookie: true, needsRefresh: false });
  });

  it('reports no auth cookie for unrelated cookies / empty headers', async () => {
    expect(await readSessionFromCookieHeader('currency_pref=eur', AUTH_ENV, { jwks })).toEqual({
      user: null,
      hasAuthCookie: false,
      needsRefresh: false,
    });
    expect((await readSessionFromCookieHeader(null, AUTH_ENV, { jwks })).hasAuthCookie).toBe(false);
  });
});

describe('resolveSessionWithRefresh — refresh deadline (checkout must never stall)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function enableAuthEnv() {
    // resolveAuthEnv falls back to process.env outside a Workers context.
    vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  }

  it('keeps the checkout deadline tight enough to never be felt as an outage', () => {
    expect(CHECKOUT_AUTH_REFRESH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CHECKOUT_AUTH_REFRESH_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it('a never-resolving refresh degrades an expired session to anonymous within the deadline', async () => {
    enableAuthEnv();
    // Supabase Auth "stalls": fetch hangs forever (rejection is the easy case —
    // try/catch covers it; a hang is what the deadline exists for).
    const hangingFetch = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal('fetch', hangingFetch);

    const nowSecs = Math.floor(Date.now() / 1000);
    const header = cookieHeaderFor(
      sessionFor(await signToken({}, { expiresInSeconds: -120 }), 'rt_test', nowSecs - 120),
    );
    const started = Date.now();
    const result = await resolveSessionWithRefresh(header, { jwks, refreshTimeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toEqual({ user: null, setCookies: [] });
    // The refresh must actually have been attempted (and stalled) — otherwise
    // this test would pass on a short-circuit that never exercised the deadline.
    expect(hangingFetch).toHaveBeenCalled();
  });

  it('a stalled refresh still returns the locally-verified user for an expiring token', async () => {
    enableAuthEnv();
    const hangingFetch = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal('fetch', hangingFetch);

    const nowSecs = Math.floor(Date.now() / 1000);
    const header = cookieHeaderFor(
      sessionFor(await signToken({}, { expiresInSeconds: 30 }), 'rt_test', nowSecs + 30),
    );
    const result = await resolveSessionWithRefresh(header, { jwks, refreshTimeoutMs: 50 });
    expect(result.user?.id).toBe(USER_ID);
    expect(result.setCookies).toEqual([]);
    expect(hangingFetch).toHaveBeenCalled();
  });

  it('skips all network work for anonymous visitors (hanging fetch never consulted)', async () => {
    enableAuthEnv();
    const hangingFetch = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal('fetch', hangingFetch);

    const result = await resolveSessionWithRefresh('currency_pref=eur', { jwks, refreshTimeoutMs: 50 });
    expect(result).toEqual({ user: null, setCookies: [] });
    expect(hangingFetch).not.toHaveBeenCalled();
  });
});
