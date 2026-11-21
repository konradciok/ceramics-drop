import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getProductById, CATEGORIES, isProductPublic, productDisplayName } from '@/lib/products';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import { JsonLd } from '@/components/seo/JsonLd';
import { productSchema } from '@/lib/seo/structured-data';
import { productAlternates } from '@/lib/seo/urls';
import { previewRobots } from '@/lib/seo/robots';
import { SITE_URL } from '@/lib/site';
import { ProductPageScreen } from '@/components/shop/ProductPageScreen';
import { StripUrlToken } from '@/components/shop/StripUrlToken';
import { getProductNote } from '@/lib/cms/messages';
import { getShippingRatesForDisplay } from '@/lib/shipping-rates/get';
import { readWithFallback } from '@/lib/supabase-timeout';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string; slug: string; id: string }>;
  searchParams?: Promise<{ preview?: string | string[] }>;
};

/** Builds `<title>`, `<meta description>`, hreflang alternates, and OG image for a product page. */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, slug, id } = await params;
  const previewParam = (await searchParams)?.preview;
  const previewToken = typeof previewParam === 'string' ? previewParam : undefined;
  const robots = previewRobots(previewParam);

  const product = await getProductById(id);
  // Wrong-category URL, a hidden family, or a non-active DB status → real 404.
  if (!product || product.category !== slug || !isProductPublic(product)) notFound();

  const t = await getTranslations({ locale });
  const cat = CATEGORIES[product.category];
  const name = t(`product.${cat.singularKey}`);
  const displayName = productDisplayName(product, name);
  const rawNotes = t.raw(`notes.${product.category}`) as unknown;
  const fallbackDescription = Array.isArray(rawNotes)
    ? ((rawNotes[product.noteIndex] as string) ?? '')
    : '';
  const note = await getProductNote(product.category, locale as Locale, product.id, previewToken).catch(() => fallbackDescription);
  // DB SEO override (db mode, when set) wins outright; otherwise the CMS-authored
  // `description` (same db-mode-only field the storefront name draws `title` from)
  // is preferred over the derived CMS note, matching seoTitle's precedence over displayName.
  const description = product.seoDescription ?? product.description ?? note;

  return {
    title: product.seoTitle ?? displayName,
    description,
    alternates: productAlternates(locale as Locale, slug, id),
    robots,
    openGraph: {
      images: [{ url: `${SITE_URL}${product.image}`, width: 1200, height: 1500, alt: displayName }],
    },
  };
}

/** Product detail page — server-rendered with force-dynamic so live sold state is always fresh. */
export default async function Page({ params, searchParams }: Props) {
  const { locale, slug, id } = await params;
  const previewParam = (await searchParams)?.preview;
  const previewToken = typeof previewParam === 'string' ? previewParam : undefined;
  setRequestLocale(locale);

  const base = await getProductById(id);
  if (!base || base.category !== (slug as CategorySlug) || !isProductPublic(base)) notFound();

  const [t, soldIds, showroomIds, shipping] = await Promise.all([
    getTranslations({ locale }),
    readWithFallback('soldIds', getSoldIds, [] as string[], { locale, slug, id }),
    readWithFallback('showroomIds', getShowroomIds, [] as string[], { locale, slug, id }),
    getShippingRatesForDisplay(),
  ]);

  const withSold = soldIds.includes(base.id) ? { ...base, sold: true } : base;
  const product = showroomIds.includes(base.id) ? { ...withSold, showroom: true } : withSold;
  const note = await getProductNote(product.category, locale as Locale, product.id, previewToken);

  return (
    <main>
      <StripUrlToken names={['preview']} />
      <JsonLd
        data={productSchema({
          product,
          locale: locale as Locale,
          t: (key: string) => t(key),
          tRaw: (key: string) => t.raw(key),
          description: note,
          shipping,
        })}
      />
      <ProductPageScreen product={product} soldIds={soldIds} showroomIds={showroomIds} noteOverride={note} shipping={shipping} />
    </main>
  );
}
