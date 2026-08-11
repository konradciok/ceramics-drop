import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getProductById, CATEGORIES, isProductPublic } from '@/lib/products';
import { getPrintById } from '@/lib/prints';
import { getPrintAssetCoverage } from '@/server/print-assets/repository';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import { JsonLd } from '@/components/seo/JsonLd';
import { printProductSchema, productSchema } from '@/lib/seo/structured-data';
import { productAlternates } from '@/lib/seo/urls';
import { SITE_URL } from '@/lib/site';
import { ProductPageScreen } from '@/components/shop/ProductPageScreen';
import { PrintProductScreen } from '@/components/shop/PrintProductScreen';
import { StripUrlToken } from '@/components/shop/StripUrlToken';
import { getProductNote } from '@/lib/cms/messages';
import { getPrintPdpContent } from '@/lib/cms/print-pdp';
import { getPrintPricingConfig } from '@/lib/print-pricing-config/get';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PRINT_SLUG = 'fine-art-prints';

type Props = {
  params: Promise<{ locale: string; slug: string; id: string }>;
  searchParams?: Promise<{ preview?: string }>;
};

/** Builds `<title>`, `<meta description>`, hreflang alternates, and OG image for a product page. */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, slug, id } = await params;
  const preview = (await searchParams)?.preview;
  // Any ?preview= URL is an admin-only draft view — never indexable, even if the
  // token is invalid (the body would just fall back to published copy).
  const robots = preview ? { index: false, follow: false } : undefined;

  if (slug === PRINT_SLUG) {
    const design = await getPrintById(id);
    if (!design || !design.published) notFound();
    const t = await getTranslations({ locale });
    const singular = t('product.print');
    const displayName = `${singular} Nº ${design.num}`;
    const rawNotes = t.raw(`notes.${PRINT_SLUG}`) as unknown;
    const fallbackDescription = Array.isArray(rawNotes) ? ((rawNotes[design.noteIndex] as string) ?? '') : '';
    const description = await getProductNote(PRINT_SLUG, locale as Locale, design.id, preview).catch(() => fallbackDescription);
    return {
      title: displayName,
      description,
      alternates: productAlternates(locale as Locale, slug, id),
      robots,
      openGraph: {
        images: [{ url: `${SITE_URL}${design.image}`, width: 1200, height: 1500, alt: displayName }],
      },
    };
  }

  const product = await getProductById(id);
  // Wrong-category URL, a hidden family, or a non-active DB status → real 404.
  if (!product || product.category !== slug || !isProductPublic(product)) notFound();

  const t = await getTranslations({ locale });
  const cat = CATEGORIES[product.category];
  const name = t(`product.${cat.singularKey}`);
  const displayName = `${name} Nº ${product.num}`;
  const rawNotes = t.raw(`notes.${product.category}`) as unknown;
  const fallbackDescription = Array.isArray(rawNotes)
    ? ((rawNotes[product.noteIndex] as string) ?? '')
    : '';
  const note = await getProductNote(product.category, locale as Locale, product.id, preview).catch(() => fallbackDescription);
  // DB SEO overrides (db mode, when set) win over the derived title / CMS note.
  const description = product.seoDescription ?? note;

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
  const preview = (await searchParams)?.preview;
  setRequestLocale(locale);

  if (slug === PRINT_SLUG) {
    const design = await getPrintById(id);
    if (!design || !design.published) notFound();
    const t = await getTranslations({ locale });
    const [note, coverage, pricing, pdpContent] = await Promise.all([
      getProductNote(PRINT_SLUG, locale as Locale, design.id, preview),
      getPrintAssetCoverage(design.id).catch(() => null),
      getPrintPricingConfig(),
      getPrintPdpContent(locale as Locale, preview),
    ]);
    // undefined = do NOT gate (registry mode / no rows / fetch error); an empty
    // array is a real "nothing usable" signal and gates every variant.
    const usableVariantKeys =
      coverage == null
        ? undefined
        : coverage.variants.length === 0
          ? []
          : coverage.variants.filter((v) => v.usable).map((v) => v.variantKey);
    return (
      <main>
        <StripUrlToken names={['preview']} />
        <JsonLd
          data={printProductSchema({
            design,
            locale: locale as Locale,
            t: (key: string) => t(key),
            tRaw: (key: string) => t.raw(key),
            description: note,
            pricing,
          })}
        />
        <PrintProductScreen design={design} noteOverride={note} usableVariantKeys={usableVariantKeys} pricing={pricing} content={pdpContent} />
      </main>
    );
  }

  const base = await getProductById(id);
  if (!base || base.category !== (slug as CategorySlug) || !isProductPublic(base)) notFound();

  const [t, soldIds, showroomIds] = await Promise.all([
    getTranslations({ locale }),
    getSoldIds().catch((err) => {
      console.error('getSoldIds failed on PDP', { locale, slug, id, err });
      return [] as string[];
    }),
    getShowroomIds().catch((err) => {
      console.error('getShowroomIds failed on PDP', { locale, slug, id, err });
      return [] as string[];
    }),
  ]);

  const withSold = soldIds.includes(base.id) ? { ...base, sold: true } : base;
  const product = showroomIds.includes(base.id) ? { ...withSold, showroom: true } : withSold;
  const note = await getProductNote(product.category, locale as Locale, product.id, preview);

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
        })}
      />
      <ProductPageScreen product={product} soldIds={soldIds} showroomIds={showroomIds} noteOverride={note} />
    </main>
  );
}
