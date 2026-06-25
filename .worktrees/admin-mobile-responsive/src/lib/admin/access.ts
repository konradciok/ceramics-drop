import { createRemoteJWKSet, jwtVerify } from 'jose';

const ADMIN_PATH_RE = /^\/admin(\/|$)|^\/api\/admin(\/|$)/;

// Cached module-level JWKS fetcher — keyed by team domain so restarts pick up
// a fresh set while normal requests reuse the cached instance.
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
  // 172.16.0.0/12 — second octet 16–31
  const parts = hostname.split('.');
  if (parts.length === 4 && parts[0] === '172') {
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATH_RE.test(pathname);
}

export type AdminAccessResult =
  | { ok: true; email?: string }
  | { ok: false; status: 403 | 404 };

export async function verifyAdminAccess(
  request: Request,
  env: Pick<
    CloudflareEnv,
    'CF_ACCESS_TEAM_DOMAIN' | 'CF_ACCESS_AUD' | 'ADMIN_ALLOWED_EMAILS' | 'STUDIO_ADMIN_LOCAL_BYPASS'
  >,
): Promise<AdminAccessResult> {
  const url = new URL(request.url);

  // Local dev bypass — only on private/loopback hosts.
  if (env.STUDIO_ADMIN_LOCAL_BYPASS === 'true' && isPrivateHost(url.hostname)) {
    return { ok: true };
  }

  // Fail closed when required config is absent on real hostnames.
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return { ok: false, status: 404 };
  }

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return { ok: false, status: 404 };
  }

  try {
    const jwks = getJwks(env.CF_ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer: env.CF_ACCESS_TEAM_DOMAIN,
      audience: env.CF_ACCESS_AUD,
    });

    const email = typeof payload.email === 'string' ? payload.email : undefined;

    if (env.ADMIN_ALLOWED_EMAILS) {
      const allowed = env.ADMIN_ALLOWED_EMAILS.split(',').map((e) => e.trim().toLowerCase());
      if (!email || !allowed.includes(email.toLowerCase())) {
        return { ok: false, status: 403 };
      }
    }

    return { ok: true, email };
  } catch {
    return { ok: false, status: 403 };
  }
}
