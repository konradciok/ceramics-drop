import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AllPiecesScreen } from '@/components/shop/AllPiecesScreen';
import { getPublicProducts } from '@/lib/products';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.sklep'),
    description: t('meta.collections.sklep'),
    alternates: alternatesFor(locale as Locale, '/sklep'),
  };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [soldIds, showroomIds] = await Promise.all([
    getSoldIds().catch(() => [] as string[]),
    getShowroomIds().catch(() => [] as string[]),
  ]);
  const sold = new Set(soldIds);
  const showroom = new Set(showroomIds);
  // Sold/showroom overlays are best-effort: a Supabase outage must not take the
  // storefront down. Fall back to none — reserve_pieces is the real guard.
  const products = (await getPublicProducts()).map((p) => {
    const merged = sold.has(p.id) ? { ...p, sold: true } : p;
    return showroom.has(p.id) ? { ...merged, showroom: true } : merged;
  });

  return (
    <main>
      <AllPiecesScreen products={products} />
    </main>
  );
}
