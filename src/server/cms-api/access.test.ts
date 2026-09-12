import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as jose from 'jose';
import { verifyCmsAccess } from './access';

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof jose>('jose');
  return { ...actual, createRemoteJWKSet: vi.fn(), jwtVerify: vi.fn() };
});

const baseEnv = {
  CMS_ACCESS_TEAM_DOMAIN: 'https://anna-ciok.cloudflareaccess.com',
  CMS_ACCESS_AUD: 'cms-aud-123',
  CMS_OWNERS: 'anna@anna-ciok.studio',
  CMS_API_LOCAL_BYPASS: undefined,
};

function req(headers: Record<string, string> = {}, hostname = 'ceramics-drop.example.com') {
  return new Request(`https://${hostname}/v1/session`, { headers });
}

describe('verifyCmsAccess', () => {
  beforeEach(() => {
    vi.mocked(jose.jwtVerify).mockReset();
  });

  it('returns 404 when CMS_ACCESS_TEAM_DOMAIN is unset (fail closed)', async () => {
    const result = await verifyCmsAccess(req({ 'Cf-Access-Jwt-Assertion': 'x' }), { ...baseEnv, CMS_ACCESS_TEAM_DOMAIN: undefined });
    expect(result).toEqual({ ok: false, status: 404 });
  });

  it('returns 401 when the JWT header is missing', async () => {
    const result = await verifyCmsAccess(req(), baseEnv);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns 401 when jwtVerify throws a generic/signature failure', async () => {
    vi.mocked(jose.jwtVerify).mockRejectedValue(new Error('bad signature'));
    const result = await verifyCmsAccess(req({ 'Cf-Access-Jwt-Assertion': 'x' }), baseEnv);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns 401 when the token is expired', async () => {
    const expiredError = Object.assign(new Error('exp claim timestamp check failed'), { code: 'ERR_JWT_EXPIRED', claim: 'exp' });
    vi.mocked(jose.jwtVerify).mockRejectedValue(expiredError);
    const result = await verifyCmsAccess(req({ 'Cf-Access-Jwt-Assertion': 'x' }), baseEnv);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns 403 (not 401) when the token has the wrong audience — a real token, wrong app', async () => {
    const audError = Object.assign(new Error('unexpected "aud" claim value'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'aud' });
    vi.mocked(jose.jwtVerify).mockRejectedValue(audError);
    const result = await verifyCmsAccess(req({ 'Cf-Access-Jwt-Assertion': 'x' }), baseEnv);
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns 403 (not 401) when the token has the wrong issuer', async () => {
    const issError = Object.assign(new Error('unexpected "iss" claim value'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'iss' });
    vi.mocked(jose.jwtVerify).mockRejectedValue(issError);
    const result = await verifyCmsAccess(req({ 'Cf-Access-Jwt-Assertion': 'x' }), baseEnv);
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns 403 when the verified email is not in CMS_OWNERS', async () => {
    vi.mocked(jose.jwtVerify).mockResolvedValue({ payload: { email: 'stranger@example.com' } } as never);
    const result = await verifyCmsAccess(req({ 'Cf-Access-Jwt-Assertion': 'x' }), baseEnv);
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns ok with the email, case-insensitively matched, on success', async () => {
    vi.mocked(jose.jwtVerify).mockResolvedValue({ payload: { email: 'Anna@Anna-Ciok.Studio' } } as never);
    const result = await verifyCmsAccess(req({ 'Cf-Access-Jwt-Assertion': 'x' }), baseEnv);
    expect(result).toEqual({ ok: true, email: 'Anna@Anna-Ciok.Studio' });
  });

  it('bypasses verification on a private host when CMS_API_LOCAL_BYPASS=true', async () => {
    const result = await verifyCmsAccess(req({}, 'localhost'), { ...baseEnv, CMS_API_LOCAL_BYPASS: 'true' });
    expect(result).toEqual({ ok: true, email: 'local-bypass@anna-ciok.studio' });
  });

  it('does not bypass on a public host even when CMS_API_LOCAL_BYPASS=true', async () => {
    const result = await verifyCmsAccess(req({}, 'ceramics-drop.example.com'), { ...baseEnv, CMS_API_LOCAL_BYPASS: 'true' });
    expect(result).toEqual({ ok: false, status: 401 });
  });
});
