import type { Metadata, ResolvingMetadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AllPiecesScreen } from '@/components/shop/AllPiecesScreen';
import { ShowroomViewAnalytics } from '@/components/shop/ShowroomViewAnalytics';
import { getPublicProducts } from '@/lib/products';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import { alternatesFor } from '@/lib/seo/urls';
import { HOME_EDITORIAL_IMAGE } from '@/lib/editorial-images';
import { SITE_URL } from '@/lib/site';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata(
  { params }: Props,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  // Spread the parent's openGraph (type, siteName) — a child openGraph object
  // replaces the parent's wholesale rather than merging with it, so
  // overriding just `images` would silently drop those fields.
  const previousOpenGraph = (await parent).openGraph ?? {};
  return {
    title: t('title.showroom'),
    description: t('meta.collections.showroom'),
    alternates: alternatesFor(locale as Locale, '/showroom'),
    // Without an override this inherits the global ceramic-mug OG fallback
    // (SEO-010); no showroom-specific asset exists yet, so reuse the curated
    // home hero photo rather than the arbitrary mug product shot.
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

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Combined public ceramics catalogue — every category in one grid,
  // independent of the `showroom` flag (which only badges a piece as
  // not-for-sale; see ProductTile). Sold/showroom overlays are best-effort:
  // a Supabase outage must not take the storefront down.
  const [soldIds, showroomIds] = await Promise.all([
    getSoldIds().catch(() => [] as string[]),
    getShowroomIds().catch(() => [] as string[]),
  ]);
  const sold = new Set(soldIds);
  const showroom = new Set(showroomIds);
  const products = (await getPublicProducts()).map((p) => {
    const merged = sold.has(p.id) ? { ...p, sold: true } : p;
    return showroom.has(p.id) ? { ...merged, showroom: true } : merged;
  });

  return (
    <main>
      <ShowroomViewAnalytics count={products.filter((p) => p.showroom).length} />
      <AllPiecesScreen products={products} />
    </main>
  );
}
