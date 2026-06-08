import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { ReturnRequestForm } from '@/components/shop/ReturnRequestForm';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ order?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('returns.heading'), robots: { index: false } };
}

export default async function Page({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { order } = await searchParams;
  // A repeated ?order=a&order=b query yields string[]; ReturnRequestForm calls
  // orderId.trim(), so collapse to a single string.
  const initialOrderId = Array.isArray(order) ? (order[0] ?? '') : (order ?? '');
  const t = await getTranslations({ locale });

  return (
    <main>
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('returns.eyebrow')}</div>
          <h1>{t('returns.heading')}</h1>
          <p className="lead">{t('returns.intro')}</p>
        </div>
      </section>
      <div className="prose-wrap">
        <div className="prose">
          <ReturnRequestForm initialOrderId={initialOrderId} />
          <p><Link href="/dostawa-i-zwroty">{t('returns.moreInfo')}</Link></p>
        </div>
      </div>
    </main>
  );
}
