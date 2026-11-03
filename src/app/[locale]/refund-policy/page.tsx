import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { richTags } from '@/components/ui/richTags';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';
import { EMAIL } from '@/lib/email-addresses';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.refundPolicy'),
    description: t('meta.refundPolicy'),
    alternates: alternatesFor(locale as Locale, '/refund-policy'),
  };
}

/**
 * Refund policy — prose page (TOC + sections). Consolidates the 14-day
 * withdrawal / return rules already published in Terms (§5/§6) and
 * Shipping & returns (§5/§6) into one dedicated document; content stays
 * word-for-word consistent with those pages rather than restating them
 * differently.
 */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  const mailLink = (c: ReactNode) => (
    <a className="inline" href={`mailto:${EMAIL.contact}`}>{c}</a>
  );

  const termsLink = (c: ReactNode) => (
    <Link className="inline" href="/regulamin">{c}</Link>
  );

  const shippingLink = (c: ReactNode) => (
    <Link className="inline" href="/dostawa-i-zwroty">{c}</Link>
  );

  return (
    <main>
      {/* ── PAGE HEAD ─────────────────────────────────────────────── */}
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('refund.eyebrow')}</div>
          <h1>{t.rich('refund.h1', richTags)}</h1>
          <p className="lead">{t('refund.lead')}</p>
        </div>
      </section>

      {/* ── PROSE WRAP ────────────────────────────────────────────── */}
      <div className="prose-wrap">
        <nav className="prose-toc">
          <div className="toc-label">{t('refund.toc')}</div>
          <ul>
            <li><a href="#odstapienie">{t('refund.toc1')}</a></li>
            <li><a href="#zgloszenie">{t('refund.toc2')}</a></li>
            <li><a href="#warunki">{t('refund.toc3')}</a></li>
            <li><a href="#platnosc">{t('refund.toc4')}</a></li>
            <li><a href="#reklamacje">{t('refund.toc5')}</a></li>
          </ul>
          <div className="updated">{t.rich('refund.updated', richTags)}</div>
        </nav>

        <div className="prose">
          <section id="odstapienie">
            <h2>{t('refund.s1H')}</h2>
            <p>{t.rich('refund.s1P', { ...richTags, termsLink, shippingLink })}</p>
          </section>

          <section id="zgloszenie">
            <h2>{t('refund.s2H')}</h2>
            <p>{t.rich('refund.s2P', { ...richTags, mailLink })}</p>
          </section>

          <section id="warunki">
            <h2>{t('refund.s3H')}</h2>
            <p>{t('refund.s3P')}</p>
            <ul className="bullets">
              <li>{t('refund.s3Li1')}</li>
              <li>{t('refund.s3Li2')}</li>
            </ul>
          </section>

          <section id="platnosc">
            <h2>{t('refund.s4H')}</h2>
            <p>{t.rich('refund.s4P', richTags)}</p>
          </section>

          <section id="reklamacje">
            <h2>{t('refund.s5H')}</h2>
            <p>{t('refund.s5P')}</p>
          </section>
        </div>
      </div>
    </main>
  );
}
