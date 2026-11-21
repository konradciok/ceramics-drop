import { describe, it, expect } from 'vitest';
import middleware, { isKontoPath, legacyRedirectTarget, SB_AUTH_COOKIE_RE } from './middleware';
import { PRINT_HANDLES, printShopRedirectTarget } from './lib/print-shop-redirects';
import { SB_AUTH_COOKIE_RE as SESSION_SB_AUTH_COOKIE_RE } from './lib/auth/session';
import { NextRequest } from 'next/server';

describe('middleware security headers', () => {
  it('sets HSTS and the hardening headers on HTML responses', async () => {
    const res = await middleware(new NextRequest('https://anna-ciok.studio/pl'));
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    const csp = res.headers.get('Content-Security-Policy-Report-Only') ?? '';
    expect(csp).toContain("default-src 'self'");
    // Clarity must be allowlisted (N-9) so a later enforce won't break it.
    expect(csp).toContain('https://*.clarity.ms');
    // Violations must be observable before enforce (F-11).
    expect(csp).toContain('report-uri /api/csp-report');
    // Assert the modern reporting directive too — removing it would still pass the
    // report-uri check while silently disabling the Reporting-Endpoints integration.
    expect(csp).toContain('report-to csp');
    expect(res.headers.get('Reporting-Endpoints')).toContain('/api/csp-report');
    // Google Maps Platform only served the retired print checkout's address
    // autocomplete; it must not linger in the allowlist.
    expect(csp).not.toContain('maps.googleapis.com');
  });
});

describe('explicit ?currency= override', () => {
  it('overrides an existing visitor preference with the explicit currency', async () => {
    const res = await middleware(
      new NextRequest('https://anna-ciok.studio/en/kubki?currency=gbp', {
        headers: { cookie: 'currency_pref=eur' },
      }),
    );
    expect(res.headers.getSetCookie()).toContainEqual(expect.stringContaining('currency_pref=gbp'));
    expect(res.headers.get('Vary')).toContain('Cookie');
  });
});

describe('printShopRedirectTarget (prints moved to the print shop)', () => {
  it.each([
    // PDPs → the same design in the shop, with Shopify's locale scheme
    // (en unprefixed, pl under /pl).
    ['/fine-art-prints/fap001', 'https://anna-ciok.com/pl/products/ostrea-01-fine-art-print'],
    ['/pl/fine-art-prints/fap001', 'https://anna-ciok.com/pl/products/ostrea-01-fine-art-print'],
    ['/en/fine-art-prints/fap001', 'https://anna-ciok.com/products/ostrea-01-fine-art-print'],
    ['/es/fine-art-prints/fap006/', 'https://anna-ciok.com/es/products/ostrea-04-fine-art-print'],
    ['/de/fine-art-prints/FAP058', 'https://anna-ciok.com/de/products/cumulus-02-fine-art-print'],
    // Unknown / archived designs and every non-PDP print surface → all prints.
    ['/fine-art-prints/fap029', 'https://anna-ciok.com/pl/collections/all'],
    ['/en/fine-art-prints/fap999', 'https://anna-ciok.com/collections/all'],
    ['/fine-art-prints', 'https://anna-ciok.com/pl/collections/all'],
    ['/de/fine-art-prints/', 'https://anna-ciok.com/de/collections/all'],
    ['/kolekcje', 'https://anna-ciok.com/pl/collections/all'],
    ['/en/kolekcje/cirrus', 'https://anna-ciok.com/collections/all'],
  ])('maps %s to %s', (pathname, expected) => {
    expect(printShopRedirectTarget(pathname)).toBe(expected);
  });

  it.each([
    '/',
    '/sklep',
    '/en/sklep',
    '/kubki',
    '/kubki/k01',
    '/fine-art-prints/fap001/extra',
    '/kolekcjex',
    '/fr/fine-art-prints/fap001',
    '/karta-podarunkowa',
  ])('leaves non-print paths alone: %s', (pathname) => {
    expect(printShopRedirectTarget(pathname)).toBeNull();
  });

  it('covers every design in the Shopify redirect map', () => {
    expect(Object.keys(PRINT_HANDLES)).toHaveLength(56);
    for (const handle of Object.values(PRINT_HANDLES)) {
      expect(handle).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-fine-art-print$/);
    }
  });
});

describe('middleware print-shop redirect', () => {
  it('301s a print PDP to the print shop, preserving the query string', async () => {
    const res = await middleware(
      new NextRequest('https://anna-ciok.studio/en/fine-art-prints/fap001?utm_source=pin'),
    );
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get('Location') ?? '');
    expect(location.origin).toBe('https://anna-ciok.com');
    expect(location.pathname).toBe('/products/ostrea-01-fine-art-print');
    expect(location.searchParams.get('utm_source')).toBe('pin');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('301s the collections hub to the shop listing', async () => {
    const res = await middleware(new NextRequest('https://anna-ciok.studio/kolekcje'));
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://anna-ciok.com/pl/collections/all');
  });

  it('does not redirect /sklep (now the ceramics shop)', async () => {
    const res = await middleware(new NextRequest('https://anna-ciok.studio/sklep'));
    expect(res.status).not.toBe(301);
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

describe('legacyRedirectTarget (P0-07 legacy Shopify redirects)', () => {
  it.each([
    ['/pages/about-me', '/o-studiu'],
    ['/en/pages/about-me', '/en/o-studiu'],
    ['/de/pages/contact', '/de/kontakt'],
    ['/pages/contact', '/kontakt'],
  ])('maps %s to %s', (pathname, expected) => {
    expect(legacyRedirectTarget(pathname)).toBe(expected);
  });

  it.each([
    '/products/novocumulus-27-fine-art-print',
    '/en/products/cumulus-05',
    '/pages/workshops',
    '/fine-art-prints/fap001',
    '/sklep',
    '/',
  ])('leaves unmapped legacy-shaped and normal paths alone: %s', (pathname) => {
    expect(legacyRedirectTarget(pathname)).toBeNull();
  });
});

describe('middleware legacy Shopify redirect', () => {
  it('301s a mapped legacy URL, preserving locale and query string', async () => {
    const res = await middleware(
      new NextRequest('https://anna-ciok.studio/en/pages/about-me?utm_source=old-bio-link'),
    );
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get('Location') ?? '');
    expect(location.pathname).toBe('/en/o-studiu');
    expect(location.searchParams.get('utm_source')).toBe('old-bio-link');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('passes an unmapped legacy-shaped URL through to normal routing (no redirect)', async () => {
    const res = await middleware(
      new NextRequest('https://anna-ciok.studio/en/products/novocumulus-27-fine-art-print'),
    );
    expect(res.status).not.toBe(301);
    expect(res.headers.get('Location')).toBeNull();
  });
});

describe('middleware konto session guard', () => {
  it('keeps the local sb-cookie pattern in sync with the session module', () => {
    // The regex is duplicated on purpose (edge-bundle parse cost); this pins
    // the two declarations together so an edit to one fails loudly.
    expect(SB_AUTH_COOKIE_RE.source).toBe(SESSION_SB_AUTH_COOKIE_RE.source);
    expect(SB_AUTH_COOKIE_RE.flags).toBe(SESSION_SB_AUTH_COOKIE_RE.flags);
  });

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
