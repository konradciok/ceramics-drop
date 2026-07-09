import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CollectionScreen } from '@/components/shop/CollectionScreen';
import { JsonLd } from '@/components/seo/JsonLd';
import { collectionSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import { CATEGORIES } from '@/lib/products';
import { assertCategoryPublic } from '@/lib/category-guard';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string; slug: string }> };

function toKey(slug: string) {
  return slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!(slug in CATEGORIES)) notFound();
  assertCategoryPublic(slug as CategorySlug);
  const key = toKey(slug);
  const t = await getTranslations({ locale });
  return {
    title: t(`title.${key}`),
    description: t(`meta.collections.${key}`),
    alternates: alternatesFor(locale as Locale, `/${slug}`),
  };
}

export default async function Page({ params }: Props) {
  const { locale, slug } = await params;
  if (!(slug in CATEGORIES)) notFound();
  setRequestLocale(locale);
  const [t, soldIds, showroomIds] = await Promise.all([
    getTranslations({ locale }),
    getSoldIds().catch(() => [] as string[]),
    getShowroomIds().catch(() => [] as string[]),
  ]);
  return (
    <main>
      <JsonLd data={collectionSchema({ slug: slug as CategorySlug, locale: locale as Locale, t, soldIds, showroomIds })} />
      <CollectionScreen slug={slug as CategorySlug} />
    </main>
  );
}
