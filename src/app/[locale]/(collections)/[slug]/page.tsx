import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CollectionScreen } from '@/components/shop/CollectionScreen';
import { JsonLd } from '@/components/seo/JsonLd';
import { collectionSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import { getSoldIds } from '@/lib/inventory';
import { VISIBLE_CATEGORY_ORDER } from '@/lib/products';
import { assertCategoryPublic } from '@/lib/category-guard';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string; slug: string }> };

export function generateStaticParams() {
  return VISIBLE_CATEGORY_ORDER.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  assertCategoryPublic(slug as CategorySlug);
  const t = await getTranslations({ locale });
  return {
    title: t(`title.${slug}`),
    description: t(`meta.collections.${slug}`),
    alternates: alternatesFor(locale as Locale, `/${slug}`),
  };
}

export default async function Page({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const [t, soldIds] = await Promise.all([
    getTranslations({ locale }),
    getSoldIds().catch(() => [] as string[]),
  ]);
  return (
    <main>
      <JsonLd data={collectionSchema({ slug: slug as CategorySlug, locale: locale as Locale, t, soldIds })} />
      <CollectionScreen slug={slug as CategorySlug} />
    </main>
  );
}
