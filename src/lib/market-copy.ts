import type { ReactNode } from 'react';
import { createTranslator } from 'next-intl';
import { routing, type Locale } from '@/i18n/routing';
import { MARKET_EXTRA_LANGS, MARKET_PATH, MARKET_SHELL_LOCALE, type MarketExtraLang } from '@/lib/market-event';
import { absoluteUrl } from '@/lib/seo/urls';

/** Every language the El Médano page ships in: the four site locales plus the page-only extras. */
export type MarketLang = Locale | MarketExtraLang;

export function isMarketExtraLang(value: string): value is MarketExtraLang {
  return (MARKET_EXTRA_LANGS as readonly string[]).includes(value);
}

/** The `market` message namespace for `lang` (site locales' own message file, extras' page-only file). */
async function loadMarketMessages(lang: MarketLang): Promise<object> {
  if (isMarketExtraLang(lang)) {
    return (await import(`../../messages/market/${lang}.json`)).default;
  }
  return (await import(`../../messages/${lang}.json`)).default.market;
}

/**
 * Loosely-typed `t`: the message tree is loaded per language at runtime, so
 * there is no compile-time key union (shape parity is guarded by a unit test).
 */
export type MarketTranslator = {
  (key: string, values?: Record<string, string | number>): string;
  rich(key: string, values: Record<string, (chunks: ReactNode) => ReactNode>): ReactNode;
};

/**
 * `t` bound to the `market` namespace for one language. One translator for all
 * ten languages keeps the page code free of "is this a routable locale" branches.
 */
export async function getMarketTranslator(lang: MarketLang): Promise<MarketTranslator> {
  const market = await loadMarketMessages(lang);
  return createTranslator({ locale: lang, messages: { market }, namespace: 'market' }) as unknown as MarketTranslator;
}

/** URL path (without locale prefix handling) a given language is served at. */
function marketUrl(lang: MarketLang): string {
  return isMarketExtraLang(lang)
    ? `${absoluteUrl(MARKET_SHELL_LOCALE, MARKET_PATH)}/${lang}`
    : absoluteUrl(lang, MARKET_PATH);
}

/** Canonical + hreflang alternates across all ten languages. */
export function marketAlternates(lang: MarketLang) {
  const languages: Record<string, string> = {};
  for (const l of [...routing.locales, ...MARKET_EXTRA_LANGS] as MarketLang[]) {
    languages[l] = marketUrl(l);
  }
  languages['x-default'] = marketUrl(MARKET_SHELL_LOCALE);
  return { canonical: marketUrl(lang), languages };
}

/** Open Graph `locale` value (`pl_PL`, `nb_NO`, …) for a language. */
export const MARKET_OG_LOCALE: Record<MarketLang, string> = {
  pl: 'pl_PL', en: 'en_GB', es: 'es_ES', de: 'de_DE',
  fr: 'fr_FR', nl: 'nl_NL', no: 'nb_NO', sv: 'sv_SE', cs: 'cs_CZ', sk: 'sk_SK',
};
