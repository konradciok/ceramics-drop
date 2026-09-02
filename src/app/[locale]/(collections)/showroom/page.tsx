import type { Metadata, ResolvingMetadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ShowroomScreen } from '@/components/shop/ShowroomScreen';
import { getShowroomProducts } from '@/lib/inventory';
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

  // Showroom overlay is best-effort: a Supabase outage degrades to an empty
  // gallery rather than 500-ing the page.
  const entries = await getShowroomProducts().catch(() => []);

  return (
    <main>
      <ShowroomScreen entries={entries} />
    </main>
  );
}
