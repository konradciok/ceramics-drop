import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { richTags } from '@/components/ui/richTags';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.polityka'),
    alternates: alternatesFor(locale as Locale, '/polityka-prywatnosci'),
  };
}

/** Privacy policy — prose page (TOC + sections). */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  const mailtoLink = (c: ReactNode) => (
    <a className="inline" href="mailto:hej@annaciok.pl">{c}</a>
  );

  const stripeLink = (c: ReactNode) => (
    <a className="inline" href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">{c}</a>
  );

  return (
    <main>
      {/* ── PAGE HEAD ─────────────────────────────────────────────── */}
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('privacy.eyebrow')}</div>
          <h1>{t.rich('privacy.h1', richTags)}</h1>
          <p className="lead">{t('privacy.lead')}</p>
        </div>
      </section>

      {/* ── PROSE WRAP ────────────────────────────────────────────── */}
      <div className="prose-wrap">
        <nav className="prose-toc">
          <div className="toc-label">{t('privacy.toc')}</div>
          <ul>
            <li><a href="#administrator">{t('privacy.toc1')}</a></li>
            <li><a href="#dane">{t('privacy.toc2')}</a></li>
            <li><a href="#cel">{t('privacy.toc3')}</a></li>
            <li><a href="#czas">{t('privacy.toc4')}</a></li>
            <li><a href="#cookies">{t('privacy.toc5')}</a></li>
            <li><a href="#prawa">{t('privacy.toc6')}</a></li>
          </ul>
          <div className="updated">{t.rich('privacy.updated', richTags)}</div>
        </nav>

        <div className="prose">
          {/* ── #administrator ───────────────────────────────────── */}
          <section id="administrator">
            <h2>{t('privacy.s1H')}</h2>
            <p>{t.rich('privacy.s1P', { ...richTags, link: mailtoLink })}</p>
          </section>

          {/* ── #dane ────────────────────────────────────────────── */}
          <section id="dane">
            <h2>{t('privacy.s2H')}</h2>
            <ul className="bullets">
              <li>{t('privacy.s2Li1')}</li>
              <li>{t('privacy.s2Li2')}</li>
              <li>{t.rich('privacy.s2Li4', { ...richTags, link: stripeLink })}</li>
              <li>{t('privacy.s2Li3')}</li>
            </ul>
            <p>{t('privacy.s2P')}</p>
          </section>

          {/* ── #cel ─────────────────────────────────────────────── */}
          <section id="cel">
            <h2>{t('privacy.s3H')}</h2>
            <p>{t.rich('privacy.s3P', { ...richTags, link: stripeLink })}</p>
          </section>

          {/* ── #czas ────────────────────────────────────────────── */}
          <section id="czas">
            <h2>{t('privacy.s4H')}</h2>
            <p>{t('privacy.s4P')}</p>
          </section>

          {/* ── #cookies ─────────────────────────────────────────── */}
          <section id="cookies">
            <h2>{t('privacy.s5H')}</h2>
            <p>{t.rich('privacy.s5P', { ...richTags, link: stripeLink })}</p>
          </section>

          {/* ── #prawa ───────────────────────────────────────────── */}
          <section id="prawa">
            <h2>{t('privacy.s6H')}</h2>
            <p>{t('privacy.s6P')}</p>
          </section>
        </div>
      </div>
    </main>
  );
}
