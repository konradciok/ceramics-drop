import { setRequestLocale, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { CartView } from '@/components/shop/CartView';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

type Props = { params: Promise<{ locale: string }> };

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

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <main id="cart-root">
      <CartView />
    </main>
  );
}
