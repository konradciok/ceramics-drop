import { createRemoteJWKSet, jwtVerify } from 'jose';

// Independent of src/lib/admin/access.ts's verifyAdminAccess: different
// audience (the CMS app's own Cloudflare Access application, not the
// storefront's /admin gate), different owners list, invoked from a
// WorkerEntrypoint's fetch() rather than the Next-facing admin gate in
// worker.ts. Same jose pattern as every other JWT verifier in this repo
// (src/lib/admin/access.ts, src/lib/auth/session.ts) — a standalone module
// with its own module-level JWKS cache, per repo convention.

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  if (!jwksCache.has(teamDomain)) {
    const url = new URL('/cdn-cgi/access/certs', teamDomain);
    jwksCache.set(teamDomain, createRemoteJWKSet(url));
  }
  return jwksCache.get(teamDomain)!;
}

function isPrivateHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.endsWith('.local')
  ) {
    return true;
  }
  const parts = hostname.split('.');
  if (parts.length === 4 && parts[0] === '172') {
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export type CmsAccessResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 404 };

export async function verifyCmsAccess(
  request: Request,
  env: Pick<CloudflareEnv, 'CMS_ACCESS_TEAM_DOMAIN' | 'CMS_ACCESS_AUD' | 'CMS_OWNERS' | 'CMS_API_LOCAL_BYPASS'>,
): Promise<CmsAccessResult> {
  const url = new URL(request.url);

  if (env.CMS_API_LOCAL_BYPASS === 'true' && isPrivateHost(url.hostname)) {
    return { ok: true, email: 'local-bypass@anna-ciok.studio' };
  }

  // Fail closed: the CMS API does not exist as a reachable surface unless
  // both the team domain and this app's audience are configured.
  if (!env.CMS_ACCESS_TEAM_DOMAIN || !env.CMS_ACCESS_AUD || !env.CMS_OWNERS) {
    return { ok: false, status: 404 };
  }

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return { ok: false, status: 401 };
  }

  let email: string | undefined;
  try {
    const jwks = getJwks(env.CMS_ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer: env.CMS_ACCESS_TEAM_DOMAIN,
      audience: env.CMS_ACCESS_AUD,
    });
    email = typeof payload.email === 'string' ? payload.email : undefined;
  } catch (err) {
    // A well-formed, correctly-signed, non-expired token issued for a
    // DIFFERENT app (wrong aud/iss — e.g. the storefront's own admin Access
    // application instead of the CMS's) is a distinct failure from "this
    // isn't even a valid token" per the brief's acceptance criteria (§8):
    // wrong audience -> 403 (a real caller, wrong door), missing/expired/
    // forged -> 401 (not a real caller at all). jose tags a claim mismatch
    // with code ERR_JWT_CLAIM_VALIDATION_FAILED and names the offending
    // claim ('aud' or 'iss'); every other failure (expired, bad signature,
    // malformed) stays 401.
    const claimError = err as { code?: string; claim?: string };
    if (claimError?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && (claimError.claim === 'aud' || claimError.claim === 'iss')) {
      return { ok: false, status: 403 };
    }
    return { ok: false, status: 401 };
  }

  const allowed = env.CMS_OWNERS.split(',').map((e) => e.trim().toLowerCase());
  if (!email || !allowed.includes(email.toLowerCase())) {
    return { ok: false, status: 403 };
  }

  return { ok: true, email };
}
