import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getProductById, CATEGORIES } from '@/lib/products';
import { getSoldIds } from '@/lib/inventory';
import { JsonLd } from '@/components/seo/JsonLd';
import { productSchema } from '@/lib/seo/structured-data';
import { productAlternates } from '@/lib/seo/urls';
import { SITE_URL } from '@/lib/site';
import { ProductPageScreen } from '@/components/shop/ProductPageScreen';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string; slug: string; id: string }> };

/** Builds `<title>`, `<meta description>`, hreflang alternates, and OG image for a product page. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug, id } = await params;
  const product = getProductById(id);
  if (!product || product.category !== slug) notFound();

  const t = await getTranslations({ locale });
  const cat = CATEGORIES[product.category];
  const name = t(`product.${cat.singularKey}`);
  const displayName = `${name} Nº ${product.num}`;
  const rawNotes = t.raw(`notes.${product.category}`) as unknown;
  const description = Array.isArray(rawNotes)
    ? ((rawNotes[product.noteIndex] as string) ?? '')
    : '';

  return {
    title: displayName,
    description,
    alternates: productAlternates(locale as Locale, slug, id),
    openGraph: {
      images: [{ url: `${SITE_URL}${product.image}`, width: 1200, height: 1500, alt: displayName }],
    },
  };
}

/** Product detail page — server-rendered with force-dynamic so live sold state is always fresh. */
export default async function Page({ params }: Props) {
  const { locale, slug, id } = await params;
  setRequestLocale(locale);

  const base = getProductById(id);
  if (!base || base.category !== (slug as CategorySlug)) notFound();

  const [t, soldIds] = await Promise.all([
    getTranslations({ locale }),
    getSoldIds().catch((err) => {
      console.error('getSoldIds failed on PDP', { locale, slug, id, err });
      return [] as string[];
    }),
  ]);

  const product = soldIds.includes(base.id) ? { ...base, sold: true } : base;

  return (
    <main>
      <JsonLd
        data={productSchema({
          product,
          locale: locale as Locale,
          t: (key: string) => t(key),
          tRaw: (key: string) => t.raw(key),
        })}
      />
      <ProductPageScreen product={product} soldIds={soldIds} />
    </main>
  );
}
