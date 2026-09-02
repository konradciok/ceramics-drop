import { describe, expect, it } from 'vitest';
import { requireLocale } from './locale-guard';

describe('requireLocale', () => {
  it('returns a configured locale unchanged', () => {
    expect(requireLocale('pl')).toBe('pl');
    expect(requireLocale('de')).toBe('de');
  });

  it('throws Next notFound (404 digest) for a junk [locale] segment', () => {
    // Regression: dotted paths (`/wp-login.php`) skip the i18n middleware
    // matcher and land in `[locale]/page.tsx` with locale='wp-login.php'.
    // The layout 404s, but the page renders concurrently and crashed on
    // LOCALE_MESSAGES[locale] — Sentry CERAMICS-DROP-1P, 300+ events.
    let thrown: unknown;
    try {
      requireLocale('wp-login.php');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { digest?: string }).digest).toMatch(/;404$/);
  });
});
