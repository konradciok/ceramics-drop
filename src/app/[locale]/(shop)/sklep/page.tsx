import type { Metadata, ResolvingMetadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { JsonLd } from '@/components/seo/JsonLd';
import { CeramicShopScreen, loadCeramicShopProducts, summariseCeramicShop } from '@/components/shop/CeramicShopScreen';
import { ceramicShopSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import { parseFamilyParam } from '@/lib/shop-family';
import { CATEGORIES } from '@/lib/products';
import { HOME_EDITORIAL_IMAGE } from '@/lib/editorial-images';
import { SITE_URL } from '@/lib/site';
import type { Locale } from '@/i18n/routing';

// The catalogue and sold state are mutable database state — never ship an
// immutable build-time prerender of the shop.
// Own route group, not `(collections)`: that group's `loading.tsx` wraps the
// page in a Suspense boundary, and a `force-dynamic` page is then streamed
// into a hidden div that only the inline swap script reveals. Without JS the
// shop would show the skeleton forever — the no-JS chip links must land on a
// fully server-rendered page. Route groups do not change the URL.
export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ rodzina?: string | string[] }>;
};

export async function generateMetadata(
  { params }: Props,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  // Spread the parent's openGraph (type, siteName) — a child openGraph object
  // replaces the parent's wholesale (Next.js metadata is shallow-merged).
  const previousOpenGraph = (await parent).openGraph ?? {};
  return {
    title: t('ceramicShop.metaTitle'),
    description: t('ceramicShop.metaDescription'),
    // Built from the path alone: `?rodzina=` is never part of the canonical.
    alternates: alternatesFor(locale as Locale, '/sklep'),
    openGraph: {
      ...previousOpenGraph,
      images: [
        {
          url: `${SITE_URL}${HOME_EDITORIAL_IMAGE.src}`,
          width: HOME_EDITORIAL_IMAGE.width,
          height: HOME_EDITORIAL_IMAGE.height,
          alt: t('home.editorialImageAlt'),
        },
      ],
    },
  };
}

/** The ceramics shop: pieces on sale now + every ceramic family. */
export default async function Page({ params, searchParams }: Props) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  // Only a visible family slug narrows the shop; an unknown, empty or withdrawn
  // family falls back to the full listing, so the URL can never blank the page.
  const family = parseFamilyParam(query?.rodzina);
  const [t, products] = await Promise.all([
    getTranslations({ locale }),
    // A cold catalogue failure is already degraded inside the loader (last
    // known good / fail-closed); never 500 the shop on top of it.
    loadCeramicShopProducts().catch(() => []),
  ]);
  const { families } = summariseCeramicShop(products);
  const schema = ceramicShopSchema({
    locale: locale as Locale,
    name: t('ceramicShop.metaTitle'),
    description: t('ceramicShop.metaDescription'),
    families: families.flatMap((f) =>
      f.cover ? [{ slug: f.slug, name: t(CATEGORIES[f.slug].nameKey), image: f.cover }] : [],
    ),
  });

  return (
    <main>
      <JsonLd data={schema} />
      <CeramicShopScreen products={products} family={family} />
    </main>
  );
}
