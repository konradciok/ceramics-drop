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

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Report-only first so it can't break Stripe/GTM/GA/Meta/InPost; tighten + enforce after observing reports.
  'Content-Security-Policy-Report-Only': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.googletagmanager.com https://*.google-analytics.com https://connect.facebook.net https://geowidget.inpost.pl",
    "style-src 'self' 'unsafe-inline' https://geowidget.inpost.pl",
    "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com https://www.facebook.com",
    "connect-src 'self' https://api.stripe.com https://*.google-analytics.com https://*.googletagmanager.com https://api-shipx-pl.easypack24.net https://*.supabase.co",
    "frame-src https://js.stripe.com https://geowidget.inpost.pl",
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The `gb` locale was collapsed into `en` (currency is now a cookie, see
  // currency.ts). Permanently redirect any legacy `/gb` or `/gb/*` URL to its
  // `/en` equivalent, preserving the rest of the path and the query string.
  if (/^\/gb(?=\/|$)/.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/en' + pathname.slice('/gb'.length);
    return NextResponse.redirect(url, 301);
  }

  // First-time visitors have no currency preference yet: derive it from
  // Cloudflare's edge geolocation (GB → GBP, everyone else → EUR). Setting it on
  // the *request* too makes the current render's `getCurrency()` see it (correct
  // first paint), and on the *response* persists it for subsequent navigations.
  const hasCurrencyCookie = request.cookies.has(CURRENCY_COOKIE);
  const currency = currencyForCountry(request.headers.get('CF-IPCountry'));
  if (!hasCurrencyCookie) {
    request.cookies.set(CURRENCY_COOKIE, currency);
  }

  const response = handleI18n(request);

  if (!hasCurrencyCookie) {
    response.cookies.set(CURRENCY_COOKIE, currency, {
      path: '/',
      maxAge: CURRENCY_COOKIE_MAX_AGE,
      sameSite: 'lax',
    });
  }

  // Rendered prices depend on the currency cookie, so a shared cache must key on
  // it — otherwise one visitor's currency could be served to another.
  response.headers.append('Vary', 'Cookie');

  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  // `admin` is excluded so the internal dashboard (outside [locale]) isn't
  // rewritten /admin → /pl/admin (which would 404).
  matcher: ['/((?!api|admin|_next|_vercel|sentry-tunnel|.*\\..*).*)'],
};
