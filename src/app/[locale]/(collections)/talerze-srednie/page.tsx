import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CollectionScreen } from '@/components/shop/CollectionScreen';
import { JsonLd } from '@/components/seo/JsonLd';
import { collectionSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import { getSoldIds } from '@/lib/inventory';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.talerzeSrednie'),
    description: t('meta.collections.talerzeSrednie'),
    alternates: alternatesFor(locale as Locale, '/talerze-srednie'),
  };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, soldIds] = await Promise.all([
    getTranslations({ locale }),
    getSoldIds().catch(() => [] as string[]),
  ]);
  return (
    <main>
      <JsonLd data={collectionSchema({ slug: 'talerze-srednie', locale: locale as Locale, t, soldIds })} />
      <CollectionScreen slug="talerze-srednie" />
    </main>
  );
}
