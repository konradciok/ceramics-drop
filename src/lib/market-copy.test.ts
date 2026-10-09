import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import es from '../../messages/es.json';
import de from '../../messages/de.json';
import { MARKET_EXTRA_LANGS, MARKET_LOOKBOOK, MARKET_PLATE_WALL, MARKET_SHOWROOM_IDS } from './market-event';
import { getMarketTranslator, isMarketExtraLang, marketAlternates, type MarketLang } from './market-copy';
import { routing } from '@/i18n/routing';

type Tree = Record<string, unknown>;

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Tree).map(([k, v]) => [k, shape(v)]));
  }
  return typeof value;
}

/** Every `{placeholder}` and `<tag>` in a string, sorted — must match across languages. */
function tokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tokens);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Tree).map(([k, v]) => [k, tokens(v)]));
  }
  return String(value).match(/\{\w+\}|<\/?\w+>/g)?.sort() ?? [];
}

const ALL: MarketLang[] = [...routing.locales, ...MARKET_EXTRA_LANGS];

async function messagesFor(lang: MarketLang): Promise<Tree> {
  return isMarketExtraLang(lang)
    ? (await import(`../../messages/market/${lang}.json`)).default
    : { pl, en, es, de }[lang as 'pl' | 'en' | 'es' | 'de'].market;
}

describe('El Médano page copy', () => {
  it('has the same keys, types, placeholders and rich-text tags in every language', async () => {
    for (const lang of ALL) {
      const messages = await messagesFor(lang);
      expect(shape(messages), lang).toEqual(shape(en.market));
      expect(tokens(messages), lang).toEqual(tokens(en.market));
    }
  });

  it('covers every photo, showroom piece and category the page renders', () => {
    const photoKeys = [...MARKET_LOOKBOOK, MARKET_PLATE_WALL].map((p) => p.image.key);
    for (const key of photoKeys) expect(en.market.photos, key).toHaveProperty(key);
    for (const id of MARKET_SHOWROOM_IDS) expect(en.market.showroom.alt, id).toHaveProperty(id);
  });

  it('leaves no untranslated English in the non-English languages', async () => {
    for (const lang of ALL.filter((l) => l !== 'en')) {
      const m = (await messagesFor(lang)) as typeof en.market;
      expect(m.hero.lead, lang).not.toBe(en.market.hero.lead);
      expect(m.take.p1, lang).not.toBe(en.market.take.p1);
      expect(m.event.dateLabel, lang).not.toBe(en.market.event.dateLabel);
    }
  });

  it('renders messages through the translator, including placeholders and rich text', async () => {
    const t = await getMarketTranslator('fr');
    expect(t('meta.title', { date: 'X' })).toContain('X');
    expect(t('lookbook.viewLarger', { caption: 'légende' })).toContain('légende');
    expect(t.rich('take.title', { em: (c) => c })).toBeTruthy();
  });

  it('declares hreflang for all ten languages, with extras under the en shell', () => {
    const { canonical, languages } = marketAlternates('sk');
    expect(canonical).toMatch(/\/en\/el-medano\/sk$/);
    expect(Object.keys(languages).sort()).toEqual([...ALL, 'x-default'].sort());
    expect(languages.pl).toMatch(/\/el-medano$/);
    expect(languages.de).toMatch(/\/de\/el-medano$/);
    expect(languages['x-default']).toMatch(/\/en\/el-medano$/);
  });
});
