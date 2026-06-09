import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AllPiecesScreen } from '@/components/shop/AllPiecesScreen';
import { getProducts } from '@/lib/products';
import { getSoldIds } from '@/lib/inventory';
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

  const soldIds = await getSoldIds().catch(() => [] as string[]);
  const sold = new Set(soldIds);
  // Sold overlay is best-effort: a Supabase outage must not take the storefront
  // down. Fall back to "nothing sold" — reserve_pieces is the double-sale guard.
  const products = getProducts().map((p) => (sold.has(p.id) ? { ...p, sold: true } : p));

  return (
    <main>
      <AllPiecesScreen products={products} />
    </main>
  );
}
