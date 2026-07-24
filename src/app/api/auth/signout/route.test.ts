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

function signoutRequest(headers: Record<string, string> = {}, fields?: Record<string, string>) {
  return new Request('https://anna-ciok.studio/api/auth/signout', {
    method: 'POST',
    headers,
    body: fields ? new URLSearchParams(fields) : undefined,
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

  it.each([
    ['pl', '/konto'],
    ['en', '/en/konto'],
    ['es', '/es/konto'],
    ['de', '/de/konto'],
  ])('preserves the %s storefront locale via the sanitized next field', async (_locale, next) => {
    const res = await POST(signoutRequest({ origin: 'https://anna-ciok.studio' }, { next }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://anna-ciok.studio${next}`);
  });

  it('falls back to / for an unsafe or external next value', async () => {
    for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await POST(signoutRequest({ origin: 'https://anna-ciok.studio' }, { next }));
      expect(res.status, `next=${next}`).toBe(303);
      expect(res.headers.get('location'), `next=${next}`).toBe('https://anna-ciok.studio/');
    }
  });
});
