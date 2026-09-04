import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { GiftCardScreen } from '@/components/shop/GiftCardScreen';
import { getPrintPdpContent } from '@/lib/cms/print-pdp';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

// Not for catalog reasons (tiers are static) but because the About-the-Artist
// band is read from the live-editable page:print-pdp CMS document — same
// staleness rationale as the home page / print PDP: an admin publish must be
// visible immediately, not cached until the next deploy.
export const dynamic = 'force-dynamic';

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

/** Gift-card PDP — tiers are static (no catalog/DB dependency); the display
 *  currency is read client-side via GiftCardConfigurator's `useCurrency()`.
 *  force-dynamic (above) is only for the CMS-sourced artist band. */
export default async function GiftCardPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Reuses the print-PDP "About the Artist" CMS document — same single
  // studio artist, no dedicated gift-card CMS document needed.
  const content = await getPrintPdpContent(locale as Locale);

  return (
    <main>
      <GiftCardScreen content={content} />
    </main>
  );
}
