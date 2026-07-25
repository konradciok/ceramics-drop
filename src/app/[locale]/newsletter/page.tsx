import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
};

const STATUSES = ['confirmed', 'expired', 'invalid', 'error'] as const;
type Status = (typeof STATUSES)[number];

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  // Transactional landing for emailed confirm links — never indexed and
  // deliberately absent from SITE_PATHS / the sitemap (the /zwrot convention).
  return { title: t('newsletter.landingTitle'), robots: { index: false, follow: false } };
}

/** Newsletter confirm landing — /api/newsletter/confirm 302s here with ?status=. */
export default async function NewsletterLandingPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { status } = await searchParams;
  // A repeated ?status=a&status=b query yields string[]; collapse to the first,
  // and treat anything unrecognised as an invalid link.
  const raw = Array.isArray(status) ? status[0] : status;
  const resolved: Status = (STATUSES as readonly string[]).includes(raw ?? '')
    ? (raw as Status)
    : 'invalid';
  const t = await getTranslations({ locale });

  return (
    <main>
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('newsletter.eyebrow')}</div>
          <h1>{t(`newsletter.${resolved}Title`)}</h1>
        </div>
      </section>
      <div className="prose-wrap">
        <div className="prose">
          <p>{t(`newsletter.${resolved}Body`)}</p>
          <p>
            <Link href="/sklep">{t('newsletter.backToShop')}</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
