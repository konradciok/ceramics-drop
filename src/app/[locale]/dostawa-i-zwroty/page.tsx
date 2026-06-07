import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { richTags } from '@/components/ui/richTags';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';
import { EMAIL } from '@/lib/email-addresses';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.dostawa'),
    alternates: alternatesFor(locale as Locale, '/dostawa-i-zwroty'),
  };
}

/** Shipping & returns — prose page (TOC + sections). */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  const mailtoLink = (c: ReactNode) => (
    <a className="inline" href={`mailto:${EMAIL.contact}`}>{c}</a>
  );

  return (
    <main>
      {/* ── PAGE HEAD ─────────────────────────────────────────────── */}
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('shipping.eyebrow')}</div>
          <h1>{t.rich('shipping.h1', richTags)}</h1>
          <p className="lead">{t('shipping.lead')}</p>
        </div>
      </section>

      {/* ── PROSE WRAP ────────────────────────────────────────────── */}
      <div className="prose-wrap">
        <nav className="prose-toc">
          <div className="toc-label">{t('shipping.toc')}</div>
          <ul>
            <li><a href="#wysylka">{t('shipping.toc1')}</a></li>
            <li><a href="#czas">{t('shipping.toc2')}</a></li>
            <li><a href="#pakowanie">{t('shipping.toc3')}</a></li>
            <li><a href="#odbior">{t('shipping.toc4')}</a></li>
            <li><a href="#zwroty">{t('shipping.toc5')}</a></li>
            <li><a href="#uszkodzenia">{t('shipping.toc6')}</a></li>
          </ul>
          <div className="updated">{t.rich('shipping.updated', richTags)}</div>
        </nav>

        <div className="prose">
          {/* ── #wysylka ─────────────────────────────────────────── */}
          <section id="wysylka">
            <h2>{t('shipping.s1H')}</h2>
            <p>{t.rich('shipping.s1P', richTags)}</p>
            <ul className="bullets">
              <li>{t('shipping.s1Li1')}</li>
              <li>{t('shipping.s1Li2')}</li>
              <li>{t('shipping.s1Li3')}</li>
            </ul>
          </section>

          {/* ── #czas ────────────────────────────────────────────── */}
          <section id="czas">
            <h2>{t('shipping.s2H')}</h2>
            <p>{t.rich('shipping.s2P', richTags)}</p>
            <div className="note"><p>{t('shipping.s2Note')}</p></div>
          </section>

          {/* ── #pakowanie ───────────────────────────────────────── */}
          <section id="pakowanie">
            <h2>{t('shipping.s3H')}</h2>
            <p>{t('shipping.s3P')}</p>
          </section>

          {/* ── #odbior ──────────────────────────────────────────── */}
          <section id="odbior">
            <h2>{t('shipping.s4H')}</h2>
            <p>{t('shipping.s4P')}</p>
          </section>

          {/* ── #zwroty ──────────────────────────────────────────── */}
          <section id="zwroty">
            <h2>{t('shipping.s5H')}</h2>
            <p>{t.rich('shipping.s5P', { ...richTags, link: mailtoLink })}</p>
            <ul className="bullets">
              <li>{t('shipping.s5Li1')}</li>
              <li>{t('shipping.s5Li2')}</li>
              <li>{t('shipping.s5Li3')}</li>
            </ul>
          </section>

          {/* ── #uszkodzenia ─────────────────────────────────────── */}
          <section id="uszkodzenia">
            <h2>{t('shipping.s6H')}</h2>
            <p>{t('shipping.s6P')}</p>
          </section>
        </div>
      </div>
    </main>
  );
}
