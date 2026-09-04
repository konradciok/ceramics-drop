import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPrintPdpContent } from '@/lib/cms/print-pdp';
import { alternatesFor } from '@/lib/seo/urls';
import { GiftCardScreen } from '@/components/shop/GiftCardScreen';
import type { Locale } from '@/i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.giftCard'),
    description: t('meta.giftCard'),
    alternates: alternatesFor(locale as Locale, '/karta-podarunkowa'),
  };
}

/** Gift card PDP. Not yet wired into cart/checkout — see GiftCardConfigurator. */
export default async function GiftCardPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const artistContent = await getPrintPdpContent(locale as Locale);

  return <GiftCardScreen artistContent={artistContent} />;
}
