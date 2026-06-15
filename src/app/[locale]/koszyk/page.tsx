import { setRequestLocale, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { CartView } from '@/components/shop/CartView';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ sale?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'title' });
  return {
    title: t('koszyk'),
    // Cart is session-specific / often empty — keep it out of the index (also excluded from sitemap).
    robots: { index: false, follow: false },
    alternates: alternatesFor(locale as Locale, '/koszyk'),
  };
}

export default async function Page({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  // A repeated ?sale=a&sale=b query yields string[]; collapse to a single token.
  const { sale } = await searchParams;
  const saleToken = Array.isArray(sale) ? (sale[0] ?? null) : (sale ?? null);

  return (
    <main id="cart-root">
      <CartView privateSaleToken={saleToken} />
    </main>
  );
}
