import { describe, expect, it, vi, beforeEach } from 'vitest';

// jose is mocked so tests are pure (no network, no real JWKS).
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => Symbol('jwks')),
  jwtVerify: vi.fn(),
}));

import { jwtVerify } from 'jose';
import { isAdminPath, verifyAdminAccess } from './access';

// ---------------------------------------------------------------------------
// isAdminPath
// ---------------------------------------------------------------------------

describe('isAdminPath', () => {
  it.each([
    '/admin',
    '/admin/',
    '/admin/fulfillment',
    '/api/admin',
    '/api/admin/',
    '/api/admin/refund',
  ])('matches %s', (path) => {
    expect(isAdminPath(path)).toBe(true);
  });

  it.each([
    '/api/checkout',
    '/api/stripe/webhook',
    '/sklep',
    '/en',
    '/en/admin', // locale prefix — intentionally not protected by this guard
    '/_next/static/chunk.js',
    '/administrator', // not /admin/ or /admin$
    '/api/administration',
  ])('does not match %s', (path) => {
    expect(isAdminPath(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyAdminAccess helpers
// ---------------------------------------------------------------------------

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

const baseEnv = {
  CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-token-abc',
  ADMIN_ALLOWED_EMAILS: undefined as string | undefined,
  STUDIO_ADMIN_LOCAL_BYPASS: undefined as string | undefined,
} satisfies Parameters<typeof verifyAdminAccess>[1];

beforeEach(() => {
  vi.mocked(jwtVerify).mockReset();
});

describe('verifyAdminAccess', () => {
  it('denies when Cf-Access-Jwt-Assertion header is missing', async () => {
    const req = makeRequest('https://anna-ciok.studio/admin');
    const result = await verifyAdminAccess(req, baseEnv);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; status: number }).status).toBe(404);
  });

  it('denies when CF_ACCESS_TEAM_DOMAIN is missing', async () => {
    const req = makeRequest('https://anna-ciok.studio/admin', {
      'Cf-Access-Jwt-Assertion': 'some.jwt.token',
    });
    const result = await verifyAdminAccess(req, {
      ...baseEnv,
      CF_ACCESS_TEAM_DOMAIN: undefined,
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; status: number }).status).toBe(404);
  });

  it('denies when CF_ACCESS_AUD is missing', async () => {
    const req = makeRequest('https://anna-ciok.studio/admin', {
      'Cf-Access-Jwt-Assertion': 'some.jwt.token',
    });
    const result = await verifyAdminAccess(req, {
      ...baseEnv,
      CF_ACCESS_AUD: undefined,
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; status: number }).status).toBe(404);
  });

  it('allows localhost with STUDIO_ADMIN_LOCAL_BYPASS=true', async () => {
    const req = makeRequest('http://localhost:3000/admin');
    const result = await verifyAdminAccess(req, {
      ...baseEnv,
      STUDIO_ADMIN_LOCAL_BYPASS: 'true',
    });
    expect(result.ok).toBe(true);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('denies localhost without bypass', async () => {
    const req = makeRequest('http://localhost:3000/admin');
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('invalid'));
    const result = await verifyAdminAccess(req, {
      ...baseEnv,
      STUDIO_ADMIN_LOCAL_BYPASS: undefined,
    });
    expect(result.ok).toBe(false);
  });

  it('denies public host even with STUDIO_ADMIN_LOCAL_BYPASS=true', async () => {
    const req = makeRequest('https://anna-ciok.studio/admin', {
      'Cf-Access-Jwt-Assertion': 'some.jwt.token',
    });
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('bad jwt'));
    const result = await verifyAdminAccess(req, {
      ...baseEnv,
      STUDIO_ADMIN_LOCAL_BYPASS: 'true',
    });
    expect(result.ok).toBe(false);
  });

  it('allows valid JWT with no email allowlist', async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { email: 'admin@ciok.art', sub: 'user-1' },
      protectedHeader: {},
    } as Awaited<ReturnType<typeof jwtVerify>>);

    const req = makeRequest('https://anna-ciok.studio/admin', {
      'Cf-Access-Jwt-Assertion': 'valid.jwt.token',
    });
    const result = await verifyAdminAccess(req, baseEnv);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; email?: string }).email).toBe('admin@ciok.art');
  });

  it('allows valid JWT with email on allowlist', async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { email: 'admin@ciok.art', sub: 'user-1' },
      protectedHeader: {},
    } as Awaited<ReturnType<typeof jwtVerify>>);

    const req = makeRequest('https://anna-ciok.studio/admin', {
      'Cf-Access-Jwt-Assertion': 'valid.jwt.token',
    });
    const result = await verifyAdminAccess(req, {
      ...baseEnv,
      ADMIN_ALLOWED_EMAILS: 'admin@ciok.art, studio@ciok.art',
    });
    expect(result.ok).toBe(true);
  });

  it('denies valid JWT with email NOT on allowlist', async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { email: 'other@example.com', sub: 'user-2' },
      protectedHeader: {},
    } as Awaited<ReturnType<typeof jwtVerify>>);

    const req = makeRequest('https://anna-ciok.studio/admin', {
      'Cf-Access-Jwt-Assertion': 'valid.jwt.token',
    });
    const result = await verifyAdminAccess(req, {
      ...baseEnv,
      ADMIN_ALLOWED_EMAILS: 'admin@ciok.art',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; status: number }).status).toBe(403);
  });

  it('denies when JWT has invalid audience/issuer/signature', async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('jwt audience invalid'));
    const req = makeRequest('https://anna-ciok.studio/admin', {
      'Cf-Access-Jwt-Assertion': 'bad.audience.token',
    });
    const result = await verifyAdminAccess(req, baseEnv);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; status: number }).status).toBe(403);
  });
});
