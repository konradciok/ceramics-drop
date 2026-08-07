import { setRequestLocale, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { CartView } from '@/components/shop/CartView';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';
import { headers } from 'next/headers';
import { isPrintCountry } from '@/lib/print-shipping';
import { getPrintPricingConfig } from '@/lib/print-pricing-config/get';

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
  const [{ locale }, requestHeaders, printPricing] = await Promise.all([
    params,
    headers(),
    getPrintPricingConfig(),
  ]);
  setRequestLocale(locale);
  // A repeated ?sale=a&sale=b query yields string[]; collapse to a single token.
  const { sale } = await searchParams;
  const saleToken = Array.isArray(sale) ? (sale[0] ?? null) : (sale ?? null);
  const cfCountry = requestHeaders.get('CF-IPCountry')?.toUpperCase() ?? '';
  const initialPrintCountry = isPrintCountry(cfCountry) ? cfCountry : 'PL';

  return (
    <main id="cart-root">
      <CartView privateSaleToken={saleToken} initialPrintCountry={initialPrintCountry} printPricing={printPricing} />
    </main>
  );
}
