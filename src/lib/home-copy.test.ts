import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createTranslator } from 'next-intl';

/**
 * Home copy stays derived, never hard-coded (audit 2026-07-16 found stale
 * prices in every locale and divergent counts in German). These tests fail if
 * anyone re-bakes a price/count into the card strings, breaks the ICU syntax,
 * or reintroduces a date-specific delivery notice.
 */

const LOCALES = ['pl', 'en', 'es', 'de'] as const;
const CARDS = [
  'mug', 'vase', 'midvase', 'bigvase', 'dish',
  'medplate', 'plate', 'largebowl', 'wavybowl',
] as const;

const messagesOf = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf-8'));

describe.each(LOCALES)('home copy (%s)', (locale) => {
  const messages = messagesOf(locale);
  const t = createTranslator({ locale, messages });

  test.each(CARDS)('card %s renders derived count + price', (card) => {
    const raw = messages.home.card[card].num as string;
    expect(raw).toContain('{count');
    expect(raw).toContain('{price}');
    // Formatting through next-intl proves the ICU syntax is valid.
    const out = t(`home.card.${card}.num` as never, { count: 29, price: '95 zł' } as never);
    expect(out).toContain('29');
    expect(out).toContain('95 zł');
  });

  test('hero copy keys are present and non-empty (CMS fallback payload)', () => {
    for (const key of ['heroLine1', 'heroLine2', 'heroTagline', 'heroCta', 'heroAlt'] as const) {
      expect(typeof messages.home[key]).toBe('string');
      expect((messages.home[key] as string).length).toBeGreaterThan(0);
    }
  });

  test('print copy renders the derived design count', () => {
    expect(messages.home.printsLead).toContain('{count');
    expect(t('home.printsLead' as never, { count: 41 } as never)).toContain('41');
    expect(messages.home.heroBeatCap).toContain('{count');
    expect(t('home.heroBeatCap' as never, { count: 41 } as never)).toContain('41');
  });

  test('delivery notice is evergreen (no month-specific dates)', () => {
    const notice = Object.values(messages.deliveryNotice as Record<string, string>).join(' ');
    expect(notice).not.toMatch(/lipc|July|julio|\bJuli\b/i);
    expect(notice).not.toMatch(/\b(5|10)\.?\s?(lipca|July|de julio|Juli)/i);
  });
});
