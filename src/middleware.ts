import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from './i18n/routing';

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
  const response = handleI18n(request);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|sentry-tunnel|.*\\..*).*)'],
};
