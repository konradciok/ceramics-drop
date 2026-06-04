import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CollectionScreen } from '@/components/shop/CollectionScreen';
import { JsonLd } from '@/components/seo/JsonLd';
import { collectionSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.miskiFalowane'),
    description: t('meta.collections.miskiFalowane'),
    alternates: alternatesFor(locale as Locale, '/miski-falowane'),
  };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });
  return (
    <main>
      <JsonLd data={collectionSchema({ slug: 'miski-falowane', locale: locale as Locale, t })} />
      <CollectionScreen slug="miski-falowane" />
    </main>
  );
}
