import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { PrintCollectionScreen } from '@/components/shop/PrintCollectionScreen';
import { JsonLd } from '@/components/seo/JsonLd';
import { printCollectionSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import { getProductNotes } from '@/lib/cms/messages';
import { getPrintPricingConfig } from '@/lib/print-pricing-config/get';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { printListingImage } from '@/lib/print-mockups';
import { groupPrintDesigns } from '@/lib/print-collections';
import { SITE_URL } from '@/lib/site';
import type { Locale } from '@/i18n/routing';

// Published designs and global pricing are mutable database state. This route
// must invoke their runtime loaders instead of shipping an immutable code-mode
// prerender produced during the Worker build.
export const dynamic = 'force-dynamic';

const PRINTS_SLUG = 'fine-art-prints';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  // Representative OG/Twitter image: the first curated design's listing
  // mockup, in the same order the collection itself renders — without this,
  // the page inherits the global ceramic mug fallback (SEO-010).
  const [hero] = groupPrintDesigns(await getPrintDesigns()).flatMap((g) => g.designs);
  const heroImage = hero ? printListingImage(hero, registryPrintById(hero.id)) : undefined;
  return {
    title: t('title.fineArtPrints'),
    description: t('meta.collections.fineArtPrints'),
    alternates: alternatesFor(locale as Locale, '/fine-art-prints'),
    ...(heroImage && {
      openGraph: {
        images: [
          {
            url: `${SITE_URL}${heroImage}`,
            width: 1200,
            height: 1714,
            alt: `${t('product.print')} Nº ${hero!.num}`,
          },
        ],
      },
    }),
  };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, notes, pricing] = await Promise.all([
    getTranslations({ locale }),
    getProductNotes(PRINTS_SLUG, locale as Locale).catch(() => ({}) as Record<string, string>),
    getPrintPricingConfig(),
  ]);
  const schema = await printCollectionSchema({ locale: locale as Locale, t, tRaw: (key) => t.raw(key), notes, pricing });
  return (
    <main>
      <JsonLd data={schema} />
      <PrintCollectionScreen locale={locale as Locale} pricing={pricing} />
    </main>
  );
}
