import { setRequestLocale } from 'next-intl/server';
import { CartView } from '@/components/shop/CartView';

type Props = { params: Promise<{ locale: string }> };

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <main>
      <CartView />
    </main>
  );
}
