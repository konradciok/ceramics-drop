import type { Metadata } from 'next';
import { getMarketTranslator, marketAlternates, MARKET_OG_LOCALE, type MarketLang } from '@/lib/market-copy';
import { MARKET_IMAGES } from '@/lib/market-event';
import { SITE_URL } from '@/lib/site';

/** `<head>` metadata for the El Médano page, shared by the site-locale and page-only-language routes. */
export async function marketMetadata(lang: MarketLang): Promise<Metadata> {
  const t = await getMarketTranslator(lang);
  const hero = MARKET_IMAGES.printsPlate;
  return {
    title: t('meta.title', { date: t('event.shortDateLabel') }),
    description: t('meta.description'),
    // One-off campaign page: shared by link/ads/QR, never sitemapped or indexed.
    robots: { index: false, follow: true },
    alternates: marketAlternates(lang),
    openGraph: {
      title: t('meta.ogTitle'),
      description: t('meta.description'),
      locale: MARKET_OG_LOCALE[lang],
      images: [
        { url: `${SITE_URL}${hero.src}`, width: hero.width, height: hero.height, alt: t('meta.ogAlt') },
      ],
    },
  };
}
