import { setRequestLocale } from 'next-intl/server';
import { CollectionScreen } from '@/components/shop/CollectionScreen';

type Props = { params: Promise<{ locale: string }> };

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <main>
      <CollectionScreen slug="miski-falowane" />
    </main>
  );
}
