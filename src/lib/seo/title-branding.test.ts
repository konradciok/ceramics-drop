import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routing } from '@/i18n/routing';

/**
 * Guard for the title-template contract.
 *
 * The root layout (`src/app/[locale]/layout.tsx`) owns the brand suffix via
 * `title.template = '%s — Anna Ciok Ceramics'`, so per-page `title.*` strings
 * must be page-only — otherwise the brand renders twice
 * (e.g. "Mugs — Anna Ciok Ceramics — Anna Ciok Ceramics").
 *
 * `title.home` is the documented exception: it leads with the brand and the
 * home page opts out of the template via `title: { absolute: ... }`.
 */
const BRAND = 'Anna Ciok Ceramics';

function loadTitles(locale: string): Record<string, string> {
  const path = fileURLToPath(new URL(`../../../messages/${locale}.json`, import.meta.url));
  const content = JSON.parse(readFileSync(path, 'utf-8'));
  if (!content.title || typeof content.title !== 'object') {
    throw new Error(`Missing or invalid 'title' object in messages/${locale}.json`);
  }
  return content.title as Record<string, string>;
}

describe('message title branding', () => {
  for (const locale of routing.locales) {
    describe(`${locale}.json`, () => {
      const titles = loadTitles(locale);

      it('does not embed the brand in any non-home title (the layout template adds it)', () => {
        const offenders = Object.entries(titles)
          .filter(([key]) => key !== 'home')
          .filter(([, value]) => value.includes(BRAND))
          .map(([key]) => key);
        expect(offenders).toEqual([]);
      });

      it('keeps the brand in title.home (which opts out of the template via title.absolute)', () => {
        expect(titles.home).toContain(BRAND);
      });
    });
  }
});
