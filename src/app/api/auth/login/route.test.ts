import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AUTH_ANTI_CACHE_HEADERS } from '@/lib/auth/session';

// Mutable env so each test can flip the fail-closed gate (presence of
// SUPABASE_PUBLISHABLE_KEY) — resolved through getCloudflareContext.
const ENV = vi.hoisted(() => ({
  env: {
    SUPABASE_URL: 'https://testref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' as string | undefined,
    WORKER_ORIGIN: undefined as string | undefined,
  },
}));

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: ENV.env }) }));

import { POST } from './route';

function loginRequest(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request('https://anna-ciok.studio/api/auth/login', {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers,
  });
}

function expectAntiCacheHeaders(res: Response) {
  for (const [key, value] of Object.entries(AUTH_ANTI_CACHE_HEADERS)) {
    expect(res.headers.get(key), key).toBe(value);
  }
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    ENV.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    ENV.env.WORKER_ORIGIN = undefined;
  });

  it('is fail-closed: 404 when SUPABASE_PUBLISHABLE_KEY is unset', async () => {
    ENV.env.SUPABASE_PUBLISHABLE_KEY = undefined;
    const res = await POST(loginRequest({ provider: 'google' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('rejects an unknown provider with 400', async () => {
    const res = await POST(loginRequest({ provider: 'github' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing form body with 400', async () => {
    const res = await POST(
      new Request('https://anna-ciok.studio/api/auth/login', { method: 'POST' }),
    );
    expect(res.status).toBe(400);
  });

  it('303s to the Supabase authorize URL with PKCE and httpOnly cookies (google)', async () => {
    const res = await POST(loginRequest({ provider: 'google', next: '/en/konto' }));
    expect(res.status).toBe(303);

    const location = res.headers.get('location')!;
    expect(location.startsWith('https://testref.supabase.co/auth/v1/authorize?')).toBe(true);
    const authorize = new URL(location);
    expect(authorize.searchParams.get('provider')).toBe('google');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    // Worker context without WORKER_ORIGIN → SITE_URL is the callback origin.
    expect(authorize.searchParams.get('redirect_to')).toBe(
      'https://anna-ciok.studio/api/auth/callback',
    );

    // PKCE verifier cookie written httpOnly via the pinned adapter…
    const cookies = res.headers.getSetCookie();
    const verifier = cookies.find((c) => c.includes('-code-verifier'));
    expect(verifier).toBeTruthy();
    expect(verifier).toMatch(/HttpOnly/i);
    expect(verifier).toMatch(/SameSite=lax/i);
    expect(verifier).toMatch(/Path=\//i);
    // …plus the sanitized next-path stash.
    const next = cookies.find((c) => c.startsWith('sb-auth-next='));
    expect(next).toContain(encodeURIComponent('/en/konto'));
    expect(next).toMatch(/HttpOnly/i);

    expectAntiCacheHeaders(res);
  });

  it('supports apple as a provider', async () => {
    const res = await POST(loginRequest({ provider: 'apple' }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).searchParams.get('provider')).toBe('apple');
  });

  it('drops an external/unsafe next value instead of stashing it', async () => {
    for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example']) {
      const res = await POST(loginRequest({ provider: 'google', next }));
      expect(res.status).toBe(303);
      const stash = res.headers.getSetCookie().find((c) => c.startsWith('sb-auth-next='));
      expect(stash, `next=${next}`).toBeUndefined();
    }
  });

  it('prefers the Worker origin from env for the callback redirect when set', async () => {
    ENV.env.WORKER_ORIGIN = 'https://staging.anna-ciok.studio';
    const res = await POST(loginRequest({ provider: 'google' }));
    const authorize = new URL(res.headers.get('location')!);
    expect(authorize.searchParams.get('redirect_to')).toBe(
      'https://staging.anna-ciok.studio/api/auth/callback',
    );
  });

  it('rate-limits repeated attempts from one IP with 429 + Retry-After', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.99' };
    let limited: Response | null = null;
    for (let i = 0; i < 11; i++) {
      const res = await POST(loginRequest({ provider: 'google' }, headers));
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited, 'limiter never engaged').not.toBeNull();
    expect(limited!.headers.get('Retry-After')).toBeTruthy();
  });
});
