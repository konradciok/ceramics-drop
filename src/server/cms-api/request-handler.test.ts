import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { handleCmsApiRequest } from './request-handler';

const TEAM_DOMAIN = 'https://anna-ciok-test.cloudflareaccess.com';
const AUD = 'cms-test-audience';
const OWNER_EMAIL = 'anna@anna-ciok.studio';

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
  privateKey = priv;
  publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/cdn-cgi/access/certs')) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function signToken(claims: Record<string, unknown>, expSecondsFromNow = 600): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow)
    .sign(privateKey);
}

const baseEnv = {
  CMS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CMS_ACCESS_AUD: AUD,
  CMS_OWNERS: OWNER_EMAIL,
} as unknown as CloudflareEnv;

const deps = { makeSupabase: () => ({}) as never };

function reqWithToken(path: string, token?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  return new Request(`https://internal.test${path}`, { ...init, headers });
}

describe('handleCmsApiRequest — real Access JWT verification (brief §8 negative scenarios)', () => {
  it('401s a request with no token at all', async () => {
    const res = await handleCmsApiRequest(reqWithToken('/v1/session'), baseEnv, deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHORIZED');
  });

  it('401s an expired token', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN }, -600);
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(401);
  });

  it('401s a token forged with the wrong signing key', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(otherKey);
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(401);
  });

  it('403s a genuinely valid token issued for the wrong audience (e.g. the storefront admin app)', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: 'some-other-app-audience', iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(403);
  });

  it('403s a genuinely valid token issued by the wrong Access team/issuer', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: 'https://someone-elses-team.cloudflareaccess.com' });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(403);
  });

  it('403s a valid, correctly-audienced token whose email is not in CMS_OWNERS', async () => {
    const token = await signToken({ email: 'stranger@example.com', aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
  });

  it('lets a valid owner token through end-to-end (real crypto verify -> router -> handler)', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe(OWNER_EMAIL);
  });

  it('404s when CMS_ACCESS_TEAM_DOMAIN/AUD/OWNERS are unset — fails closed, leaks no surface', async () => {
    const res = await handleCmsApiRequest(reqWithToken('/v1/session'), {} as CloudflareEnv, deps);
    expect(res.status).toBe(404);
  });

  it('404s an unregistered S2/S3/S4 path even carrying a fully valid owner token', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/collections', token), baseEnv, deps);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_IMPLEMENTED');
  });

  it('422s POST /v1/products with a valid owner token but no Idempotency-Key', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(
      reqWithToken('/v1/products', token, { method: 'POST', body: JSON.stringify({}) }),
      baseEnv,
      deps,
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });
});
