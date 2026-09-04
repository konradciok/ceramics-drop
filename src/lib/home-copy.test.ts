import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createTranslator } from 'next-intl';

/**
 * Home copy stays derived, never hard-coded (audit 2026-07-16 found stale
 * prices in every locale and divergent counts in German; the 2026-09-04
 * print-first redesign removed the ceramic category cards entirely). These
 * tests fail if anyone re-bakes a count into the collections/print strings,
 * breaks the ICU syntax, reintroduces a date-specific delivery notice, or
 * lets a dated ceramics-drop announcement back into the page `<title>`.
 */

const LOCALES = ['pl', 'en', 'es', 'de'] as const;

const messagesOf = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf-8'));

describe.each(LOCALES)('home copy (%s)', (locale) => {
  const messages = messagesOf(locale);
  const t = createTranslator({ locale, messages });

  test('hero copy keys are present and non-empty (CMS fallback payload)', () => {
    for (const key of ['heroLine1', 'heroLine2', 'heroTagline', 'heroCta', 'heroAlt'] as const) {
      expect(typeof messages.home[key]).toBe('string');
      expect((messages.home[key] as string).length).toBeGreaterThan(0);
    }
  });

  test('print rail copy renders the derived design count', () => {
    expect(messages.home.printsLead).toContain('{count');
    expect(t('home.printsLead' as never, { count: 41 } as never)).toContain('41');
  });

  test('collections index copy renders the derived per-collection count', () => {
    expect(messages.home.collectionsCount).toContain('{count');
    expect(t('home.collectionsCount' as never, { count: 5 } as never)).toContain('5');
  });

  test('no ceramic category cards remain in home copy', () => {
    expect(messages.home.card).toBeUndefined();
  });

  test('no ceramics/prints split logistics or shipping copy remains', () => {
    for (const key of ['colEyebrow', 'colTitle', 'colAllCta', 'colLead', 'heroBeatCap', 'lgCeramicH', 'lgCeramicP', 'lgPrintsH', 'lgPrintsP', 'ctLShip', 'ctVShip'] as const) {
      expect(messages.home[key]).toBeUndefined();
    }
  });

  test('the page title is evergreen — no dated ceramics-drop announcement', () => {
    const title = messages.title.home as string;
    expect(title.length).toBeGreaterThan(0);
    // Home opts out of the layout's brand-suffix template (see
    // seo/title-branding.test.ts), so it must carry the brand itself.
    expect(title).toContain('Anna Ciok Ceramics');
    expect(title).not.toMatch(/\bdrop\b/i);
    expect(title).not.toMatch(/20\d{2}/);
  });

  test('delivery notice is evergreen (no month-specific dates)', () => {
    const notice = Object.values(messages.deliveryNotice as Record<string, string>).join(' ');
    expect(notice).not.toMatch(/lipc|July|julio|\bJuli\b/i);
    expect(notice).not.toMatch(/\b(5|10)\.?\s?(lipca|July|de julio|Juli)/i);
  });
});
