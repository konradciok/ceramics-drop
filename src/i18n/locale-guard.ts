import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { routing, type Locale } from './routing';

/**
 * Narrow a raw `[locale]` segment to a configured locale or 404.
 *
 * The `[locale]` layout already does this, but Next renders a page and its
 * layout concurrently, so a page that touches locale-keyed tables before the
 * layout's `notFound()` lands still throws (and reports to Sentry). Paths with
 * a dot (`/wp-login.php`) skip the i18n middleware matcher entirely and reach
 * `[locale]/page.tsx` with `locale = 'wp-login.php'` — call this first there.
 */
export function requireLocale(locale: string): Locale {
  if (!hasLocale(routing.locales, locale)) notFound();
  return locale as Locale;
}
