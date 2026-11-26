import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createTranslator } from 'next-intl';

/**
 * Home copy stays derived, never hard-coded (audit 2026-07-16 found stale
 * prices in every locale and divergent counts in German). Since 2026-11 the
 * homepage is ceramics-first again — fine-art prints moved to their own shop
 * (PRINT_SHOP_URL) — and the family cards derive their counts from the
 * catalogue. These tests fail if anyone re-bakes a count into those strings,
 * lets print-shop copy back onto the page,
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

  test('no print-shop copy remains (prints moved to their own shop)', () => {
    for (const key of ['printsEyebrow', 'printsTitle', 'printsLead', 'printsCta', 'printsFacts', 'lgMaterialH', 'lgMaterialP', 'lgShippingH', 'lgShippingP', 'ctLShipPrints', 'ctVShipPrints'] as const) {
      expect(messages.home[key]).toBeUndefined();
    }
    expect(messages.announcePromo).toBeUndefined();
  });

  test('the homepage points to the print shop', () => {
    for (const key of ['printsMovedEyebrow', 'printsMovedTitle', 'printsMovedLead', 'printsMovedCta'] as const) {
      expect((messages.home[key] as string).length).toBeGreaterThan(0);
    }
  });

  test('the announcement bar promotes the drop, not the print shop', () => {
    // The bar links to /sklep (Header.tsx); the print shop keeps its nav and
    // footer links.
    expect((messages.announce as string).length).toBeGreaterThan(0);
    expect(messages.announce).not.toContain('anna-ciok.com');
  });

  test('the "available now" row copy is present', () => {
    for (const key of ['piecesEyebrow', 'piecesTitle', 'piecesLead', 'piecesCta'] as const) {
      expect((messages.home[key] as string).length).toBeGreaterThan(0);
    }
  });

  test('family card copy renders the derived per-family count', () => {
    expect(messages.home.collectionsCount).toContain('{count');
    expect(t('home.collectionsCount' as never, { count: 5 } as never)).toContain('5');
  });

  test('no ceramic category cards remain in home copy', () => {
    expect(messages.home.card).toBeUndefined();
  });

  test('no ceramics/prints split logistics copy remains', () => {
    for (const key of ['colEyebrow', 'colTitle', 'colAllCta', 'colLead', 'heroBeatCap', 'lgCeramicH', 'lgCeramicP', 'lgPrintsH', 'lgPrintsP'] as const) {
      expect(messages.home[key]).toBeUndefined();
    }
  });

  test('ceramic shop copy renders both family counts', () => {
    const label = t('ceramicShop.familyCount' as never, { count: 12, available: 3 } as never);
    expect(label).toContain('12');
    expect(label).toContain('3');
  });

  test('the page title is evergreen — no dated ceramics-drop announcement', () => {
    const title = messages.title.home as string;
    expect(title.length).toBeGreaterThan(0);
    // Home opts out of the layout's brand-suffix template (see
    // seo/title-branding.test.ts), so it must carry the brand itself.
    expect(title).toContain('Anna Ciok Studio');
    expect(title).not.toMatch(/\bdrop\b/i);
    expect(title).not.toMatch(/20\d{2}/);
  });

  test('delivery notice is evergreen (no month-specific dates)', () => {
    const notice = Object.values(messages.deliveryNotice as Record<string, string>).join(' ');
    expect(notice).not.toMatch(/lipc|July|julio|\bJuli\b/i);
    expect(notice).not.toMatch(/\b(5|10)\.?\s?(lipca|July|de julio|Juli)/i);
  });
});
