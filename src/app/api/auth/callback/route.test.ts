import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AUTH_ANTI_CACHE_HEADERS } from '@/lib/auth/session';

const ENV = vi.hoisted(() => ({
  env: {
    SUPABASE_URL: 'https://testref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' as string | undefined,
  },
}));

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: ENV.env }) }));

// The backfill only runs after a successful code exchange (network) — these
// tests cover the no-exchange paths, so the admin client must never be built.
const LINK = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/account/link-orders', () => ({
  linkOrdersToUser: async () => {
    LINK.calls++;
  },
}));

import { GET } from './route';

function callbackRequest(query: string, cookie?: string) {
  return new Request(`https://anna-ciok.studio/api/auth/callback${query}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe('GET /api/auth/callback', () => {
  beforeEach(() => {
    ENV.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    LINK.calls = 0;
  });

  it('is fail-closed: 404 when SUPABASE_PUBLISHABLE_KEY is unset', async () => {
    ENV.env.SUPABASE_PUBLISHABLE_KEY = undefined;
    const res = await GET(callbackRequest('?code=abc'));
    expect(res.status).toBe(404);
  });

  it('redirects provider errors to /konto?auth_error=1 without minting session cookies', async () => {
    const res = await GET(callbackRequest('?error=access_denied&error_description=nope'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://anna-ciok.studio/konto?auth_error=1');
    const cookies = res.headers.getSetCookie();
    // Only the next-path stash is consumed — no sb-*-auth-token appears.
    expect(cookies.some((c) => /^sb-.+-auth-token/.test(c))).toBe(false);
    expect(cookies.find((c) => c.startsWith('sb-auth-next='))).toMatch(/Max-Age=0/i);
    expect(LINK.calls).toBe(0);
    for (const [key, value] of Object.entries(AUTH_ANTI_CACHE_HEADERS)) {
      expect(res.headers.get(key)).toBe(value);
    }
  });

  it('treats a missing code as an error return', async () => {
    const res = await GET(callbackRequest(''));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://anna-ciok.studio/konto?auth_error=1');
    expect(LINK.calls).toBe(0);
  });

  it('never redirects to an unsafe stashed next value (re-sanitized on consumption)', async () => {
    const res = await GET(
      callbackRequest('?error=access_denied', 'sb-auth-next=https%3A%2F%2Fevil.example%2Fx'),
    );
    expect(res.headers.get('location')).toBe('https://anna-ciok.studio/konto?auth_error=1');
  });
});
