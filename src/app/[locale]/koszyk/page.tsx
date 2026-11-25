import { setRequestLocale, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { CartView } from '@/components/shop/CartView';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';
import { getShippingRatesForDisplay } from '@/lib/shipping-rates/get';
import { checkoutDestinationOptions } from '@/lib/shipping-rates/delivery-rates';
import { checkoutCountries, defaultCheckoutCountry, DELIVERY_COUNTRY_COOKIE } from '@/lib/delivery/destinations';

// Reads the CMS-published shipping table, so it must render per request (a
// prerender would bake in the build-time code constants).
export const dynamic = 'force-dynamic';

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
  const [{ locale }, shippingRates, requestHeaders, cookieStore] = await Promise.all([
    params,
    getShippingRatesForDisplay(),
    headers(),
    cookies(),
  ]);
  setRequestLocale(locale);
  // The countries checkout offers (registry flags or CHECKOUT_COUNTRIES), each
  // with the table it is charged from — the same resolution /api/checkout runs.
  const countries = checkoutCountries();
  const defaultCountry = defaultCheckoutCountry(countries, {
    saved: cookieStore.get(DELIVERY_COUNTRY_COOKIE)?.value,
    ipCountry: requestHeaders.get('cf-ipcountry'),
    locale,
  });
  // A repeated ?sale=a&sale=b query yields string[]; collapse to a single token.
  const { sale } = await searchParams;
  const saleToken = Array.isArray(sale) ? (sale[0] ?? null) : (sale ?? null);

  return (
    <main id="cart-root">
      <CartView
        privateSaleToken={saleToken}
        destinations={checkoutDestinationOptions(shippingRates, countries)}
        defaultCountry={defaultCountry}
      />
    </main>
  );
}
