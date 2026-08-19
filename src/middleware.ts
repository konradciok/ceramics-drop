import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import {
  CURRENCY_COOKIE,
  CURRENCY_COOKIE_MAX_AGE,
  currencyForCountry,
} from './lib/currency';

// NOTE: This stays `middleware.ts` (not the Next 16 `proxy.ts`) on purpose.
// `@opennextjs/cloudflare` only bundles edge-runtime middleware; renaming to
// `proxy.ts` flips it to the Node.js runtime ("Proxy does not support Edge
// runtime"), which OpenNext rejects ("Node.js middleware is not currently
// supported"), breaking the Cloudflare deploy build. Revisit when OpenNext
// supports the Node-runtime proxy. The Next deprecation warning is harmless.

const handleI18n = createMiddleware(routing);

// Customer-account paths: `/konto` and `/konto/zamowienia/<id>`, with or
// without a locale prefix (the pages live under `src/app/[locale]/konto/`).
// Derived from routing.locales so a new locale can never go stale; the
// `(?:/|$)` boundary keeps `/kontakt` (and any future `/konto-*`) out.
const KONTO_RE = new RegExp(`^/(?:(?:${routing.locales.join('|')})/)?konto(?:/|$)`);
// Supabase session cookie (or one of its chunked `.0`, `.1`, … parts).
// Deliberately re-declared instead of imported from src/lib/auth/session.ts so
// anonymous storefront traffic never parses the auth stack in the edge bundle;
// a parity test in middleware.test.ts guards against the two drifting apart.
export const SB_AUTH_COOKIE_RE = /^sb-.+-auth-token(?:\.\d+)?$/;

/** Exported for unit tests — see middleware.test.ts. */
export function isKontoPath(pathname: string): boolean {
  return KONTO_RE.test(pathname);
}

/**
 * Refresh an expiring customer session for `/konto` pages (RSCs cannot write
 * cookies, so the middleware owns the rotation). Reached only behind two cheap
 * guards (path regex + sb-* cookie presence) and imports the auth stack
 * lazily, so anonymous storefront traffic never parses it in the edge bundle.
 * Fail-open to signed-out rendering: an auth outage must never break a page.
 */
async function refreshKontoSession(
  request: NextRequest,
  response: ReturnType<typeof handleI18n>,
): Promise<ReturnType<typeof handleI18n>> {
  try {
    const { resolveSessionWithRefresh, applyAuthAntiCacheHeaders } = await import('./lib/auth/session');
    const { setCookies } = await resolveSessionWithRefresh(request.headers.get('cookie'));
    if (setCookies.length > 0) {
      for (const cookie of setCookies) {
        response.cookies.set(cookie.name, cookie.value, cookie.options);
      }
      // Rotated tokens ride this response — it must never be cached (§7).
      applyAuthAntiCacheHeaders(response.headers);
    }
  } catch (err) {
    console.error('konto session refresh failed', err);
  }
  return response;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Reporting-Endpoints': 'csp="/api/csp-report"',
  // Report-only first so it can't break Stripe/GTM/GA/Meta/InPost/Clarity; tighten + enforce after observing reports.
  'Content-Security-Policy-Report-Only': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.googletagmanager.com https://*.google-analytics.com https://connect.facebook.net https://geowidget.inpost.pl https://*.clarity.ms https://maps.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://geowidget.inpost.pl",
    "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com https://www.facebook.com https://*.clarity.ms",
    "connect-src 'self' https://api.stripe.com https://*.google-analytics.com https://*.googletagmanager.com https://api-shipx-pl.easypack24.net https://*.supabase.co https://*.clarity.ms https://maps.googleapis.com",
    "frame-src https://js.stripe.com https://geowidget.inpost.pl",
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-uri /api/csp-report",       // legacy reporting (Safari/older Chromium)
    "report-to csp",                      // modern reporting group (Reporting-Endpoints)
  ].join('; '),
};

// `Secure` only over HTTPS — omitting it on http://localhost lets the currency
// switcher work in local dev (a Secure cookie is dropped on plain http).
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

function applySecurityHeaders(response: ReturnType<typeof handleI18n>): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
}

function setCurrencyCookie(response: ReturnType<typeof handleI18n>, currency: string): void {
  response.cookies.set(CURRENCY_COOKIE, currency, {
    path: '/',
    maxAge: CURRENCY_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
  });
}

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCurrencyCookie = request.cookies.has(CURRENCY_COOKIE);

  // The `gb` locale was collapsed into `en` (currency is now a cookie, see
  // currency.ts). Permanently redirect any legacy `/gb` or `/gb/*` URL to its
  // `/en` equivalent, preserving the rest of the path and the query string. A
  // bookmarked `/gb` URL used to guarantee GBP pricing, so seed GBP for these
  // visitors (unless they already chose a currency), and carry the security
  // headers the normal response path sets.
  if (/^\/gb(?=\/|$)/.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/en' + pathname.slice('/gb'.length);
    const redirect = NextResponse.redirect(url, 301);
    if (!hasCurrencyCookie) setCurrencyCookie(redirect, 'gbp');
    // This 301 carries a per-visitor `Set-Cookie: currency_pref`; mark it
    // uncacheable so a shared/CDN cache can't replay one visitor's currency
    // seed onto another. The redirect itself is cheap to recompute.
    redirect.headers.set('Cache-Control', 'private, no-store');
    applySecurityHeaders(redirect);
    return redirect;
  }

  // First-time visitors have no currency preference yet: derive it from
  // Cloudflare's edge geolocation (GB → GBP, everyone else → EUR). Setting it on
  // the *request* too makes the current render's `getCurrency()` see it (correct
  // first paint), and on the *response* persists it for subsequent navigations.
  const currency = currencyForCountry(request.headers.get('CF-IPCountry'));
  if (!hasCurrencyCookie) {
    request.cookies.set(CURRENCY_COOKIE, currency);
  }

  const response = handleI18n(request);

  if (!hasCurrencyCookie) {
    setCurrencyCookie(response, currency);
  }

  // Rendered prices depend on the currency cookie, so a shared cache must key on
  // it — otherwise one visitor's currency could be served to another.
  response.headers.append('Vary', 'Cookie');

  applySecurityHeaders(response);

  // Customer session refresh — account paths only, and only when a Supabase
  // auth cookie exists (anonymous visitors skip in these two cheap guards).
  if (
    isKontoPath(pathname) &&
    request.cookies.getAll().some((cookie) => SB_AUTH_COOKIE_RE.test(cookie.name))
  ) {
    return refreshKontoSession(request, response);
  }

  return response;
}

export const config = {
  // `admin` is excluded so the internal dashboard (outside [locale]) isn't
  // rewritten /admin → /pl/admin (which would 404).
  matcher: ['/((?!api|admin|_next|_vercel|sentry-tunnel|.*\\..*).*)'],
};
