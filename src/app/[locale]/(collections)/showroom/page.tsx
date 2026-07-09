import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ShowroomScreen } from '@/components/shop/ShowroomScreen';
import { getShowroomProducts } from '@/lib/inventory';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.showroom'),
    description: t('meta.collections.showroom'),
    alternates: alternatesFor(locale as Locale, '/showroom'),
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
