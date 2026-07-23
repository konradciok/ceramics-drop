import { describe, it, expect } from 'vitest';
import middleware, { isKontoPath } from './middleware';
import { NextRequest } from 'next/server';

describe('middleware security headers', () => {
  it('sets HSTS and the hardening headers on HTML responses', async () => {
    const res = await middleware(new NextRequest('https://anna-ciok.studio/pl'));
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('Content-Security-Policy-Report-Only')).toContain("default-src 'self'");
  });
});

describe('isKontoPath (customer-account matcher)', () => {
  it.each([
    '/konto',
    '/konto/',
    '/konto/zamowienia/9a6f0f1e-1111-2222-3333-444455556666',
    '/en/konto',
    '/es/konto',
    '/de/konto',
    '/en/konto/zamowienia/abc',
    // Harmless: next-intl's as-needed redirect strips the default-locale prefix.
    '/pl/konto',
  ])('matches %s', (pathname) => {
    expect(isKontoPath(pathname)).toBe(true);
  });

  it.each([
    '/kontakt',
    '/en/kontakt',
    '/kontomatic',
    '/sklep',
    '/',
    '/fr/konto', // not a configured locale
  ])('does not match %s', (pathname) => {
    expect(isKontoPath(pathname)).toBe(false);
  });
});

describe('middleware konto session guard', () => {
  it('leaves /konto untouched for anonymous visitors (no sb-* cookie)', async () => {
    const res = await middleware(new NextRequest('https://anna-ciok.studio/konto'));
    // Normal storefront response path: security headers, no auth cookies, and
    // no auth anti-cache stamp (the page itself is force-dynamic anyway).
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.getSetCookie().some((c) => /^sb-/.test(c))).toBe(false);
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('must-revalidate');
  });

  it('no-ops the refresh when auth is not configured, even with an sb cookie present', async () => {
    // SUPABASE_PUBLISHABLE_KEY is not set in this test env → the lazy-loaded
    // session module reports auth disabled and the response passes through.
    const req = new NextRequest('https://anna-ciok.studio/konto', {
      headers: { cookie: 'sb-testref-auth-token=base64-garbage' },
    });
    const res = await middleware(req);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.getSetCookie().some((c) => /^sb-/.test(c))).toBe(false);
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('must-revalidate');
  });

  it('never engages the auth path for non-konto pages with sb cookies', async () => {
    const req = new NextRequest('https://anna-ciok.studio/kontakt', {
      headers: { cookie: 'sb-testref-auth-token=base64-garbage' },
    });
    const res = await middleware(req);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('must-revalidate');
  });
});
