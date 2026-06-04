import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Match all pathnames except for
  // - API routes
  // - Next.js internals (_next, _vercel)
  // - static files (anything with a dot, e.g. /favicon.ico, /fonts/*.otf)
  matcher: ['/((?!api|_next|_vercel|sentry-tunnel|.*\\..*).*)'],
};
