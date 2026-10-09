import '@/styles/market.css';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { requireLocale } from '@/i18n/locale-guard';
import { MarketPage } from '@/components/market/MarketPage';
import { isMarketExtraLang } from '@/lib/market-copy';
import { marketMetadata } from '@/lib/market-metadata';
import { MARKET_EXTRA_LANGS, MARKET_PATH, MARKET_SHELL_LOCALE } from '@/lib/market-event';

type Props = { params: Promise<{ locale: string; lang: string }> };

export function generateStaticParams() {
  return MARKET_EXTRA_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang } = await params;
  if (!isMarketExtraLang(lang)) return {};
  return marketMetadata(lang);
}

/**
 * Page-only languages (fr, nl, no, sv, cs, sk) of the El Médano campaign page.
 * They are not site locales: the page body is translated but the header,
 * footer and cookie banner come from the `en` shell, so every other locale
 * prefix redirects to `/en/el-medano/<lang>`.
 */
export default async function ElMedanoLangPage({ params }: Props) {
  const { locale: rawLocale, lang } = await params;
  const locale = requireLocale(rawLocale);
  if (!isMarketExtraLang(lang)) notFound();
  if (locale !== MARKET_SHELL_LOCALE) {
    redirect({ href: `${MARKET_PATH}/${lang}`, locale: MARKET_SHELL_LOCALE });
  }
  setRequestLocale(locale);
  return <MarketPage lang={lang} />;
}
