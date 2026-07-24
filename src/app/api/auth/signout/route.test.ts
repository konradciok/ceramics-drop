import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AUTH_ANTI_CACHE_HEADERS } from '@/lib/auth/session';

const ENV = vi.hoisted(() => ({
  env: {
    SUPABASE_URL: 'https://testref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' as string | undefined,
  },
}));

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: ENV.env }) }));

import { POST } from './route';

function signoutRequest(headers: Record<string, string> = {}) {
  return new Request('https://anna-ciok.studio/api/auth/signout', { method: 'POST', headers });
}

/** Same-origin form POST carrying the SignOutButton's hidden `next` field. */
function signoutFormRequest(next: string) {
  return new Request('https://anna-ciok.studio/api/auth/signout', {
    method: 'POST',
    headers: {
      origin: 'https://anna-ciok.studio',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ next }).toString(),
  });
}

describe('POST /api/auth/signout', () => {
  beforeEach(() => {
    ENV.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  });

  it('is fail-closed: 404 when SUPABASE_PUBLISHABLE_KEY is unset', async () => {
    ENV.env.SUPABASE_PUBLISHABLE_KEY = undefined;
    expect((await POST(signoutRequest())).status).toBe(404);
  });

  it('rejects a cross-origin form POST (CSRF)', async () => {
    const res = await POST(signoutRequest({ origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin POST and 303s home with anti-cache headers', async () => {
    // No session cookies → signOut has nothing to revoke (no network) and the
    // route still completes cleanly.
    const res = await POST(signoutRequest({ origin: 'https://anna-ciok.studio' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://anna-ciok.studio/');
    for (const [key, value] of Object.entries(AUTH_ANTI_CACHE_HEADERS)) {
      expect(res.headers.get(key)).toBe(value);
    }
  });

  // Signing out must land back on the caller's localized account page — a
  // customer leaving /es/konto must not be dumped on the Polish homepage.
  it.each([
    ['pl', '/konto'],
    ['en', '/en/konto'],
    ['es', '/es/konto'],
    ['de', '/de/konto'],
  ])('preserves the %s storefront locale via the form `next` path', async (_locale, next) => {
    const res = await POST(signoutFormRequest(next));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://anna-ciok.studio${next}`);
  });

  it.each([
    ['absolute external URL', 'https://evil.example/phish'],
    ['protocol-relative URL', '//evil.example'],
    ['backslash smuggling', '/\\evil.example'],
  ])('falls back to home for an unsafe next value (%s)', async (_kind, next) => {
    const res = await POST(signoutFormRequest(next));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://anna-ciok.studio/');
  });
});
