import { setRequestLocale, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { CartView } from '@/components/shop/CartView';
import { Icon } from '@/components/ui/Icon';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'title' });
  return { title: t('koszyk') };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'cart' });

  return (
    <main id="cart-root">
      <div className="sim-banner">
        <Icon name="info" />
        <span>{t('simBanner')}</span>
      </div>
      <CartView />
    </main>
  );
}
