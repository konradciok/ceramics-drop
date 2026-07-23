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
});
