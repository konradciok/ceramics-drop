import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { richTags } from '@/components/ui/richTags';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('title.regulamin') };
}

/** Terms of service — prose page (TOC + sections). */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  const mailtoLink = (c: ReactNode) => (
    <a className="inline" href="mailto:hej@annaciok.pl">{c}</a>
  );

  const dostawaLink = (c: ReactNode) => (
    <Link className="inline" href="/dostawa-i-zwroty">{c}</Link>
  );

  return (
    <main>
      {/* ── PAGE HEAD ─────────────────────────────────────────────── */}
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('terms.eyebrow')}</div>
          <h1>{t.rich('terms.h1', richTags)}</h1>
          <p className="lead">{t('terms.lead')}</p>
        </div>
      </section>

      {/* ── PROSE WRAP ────────────────────────────────────────────── */}
      <div className="prose-wrap">
        <nav className="prose-toc">
          <div className="toc-label">{t('terms.toc')}</div>
          <ul>
            <li><a href="#ogolne">{t('terms.toc1')}</a></li>
            <li><a href="#zamowienia">{t('terms.toc2')}</a></li>
            <li><a href="#ceny">{t('terms.toc3')}</a></li>
            <li><a href="#realizacja">{t('terms.toc4')}</a></li>
            <li><a href="#odstapienie">{t('terms.toc5')}</a></li>
            <li><a href="#reklamacje">{t('terms.toc6')}</a></li>
            <li><a href="#postanowienia">{t('terms.toc7')}</a></li>
          </ul>
          <div className="updated">{t.rich('terms.updated', richTags)}</div>
        </nav>

        <div className="prose">
          <div className="note"><p>{t('terms.protoNote')}</p></div>

          {/* ── #ogolne ──────────────────────────────────────────── */}
          <section id="ogolne">
            <h2>{t('terms.s1H')}</h2>
            <p>{t.rich('terms.s1P1', { ...richTags, link: mailtoLink })}</p>
            <p>{t('terms.s1P2')}</p>
          </section>

          {/* ── #zamowienia ──────────────────────────────────────── */}
          <section id="zamowienia">
            <h2>{t('terms.s2H')}</h2>
            <p>{t('terms.s2P')}</p>
            <ul className="bullets">
              <li>{t('terms.s2Li1')}</li>
              <li>{t('terms.s2Li2')}</li>
            </ul>
          </section>

          {/* ── #ceny ────────────────────────────────────────────── */}
          <section id="ceny">
            <h2>{t('terms.s3H')}</h2>
            <p>{t('terms.s3P')}</p>
          </section>

          {/* ── #realizacja ──────────────────────────────────────── */}
          <section id="realizacja">
            <h2>{t('terms.s4H')}</h2>
            <p>{t.rich('terms.s4P', { ...richTags, link: dostawaLink })}</p>
          </section>

          {/* ── #odstapienie ─────────────────────────────────────── */}
          <section id="odstapienie">
            <h2>{t('terms.s5H')}</h2>
            <p>{t('terms.s5P')}</p>
          </section>

          {/* ── #reklamacje ──────────────────────────────────────── */}
          <section id="reklamacje">
            <h2>{t('terms.s6H')}</h2>
            <p>{t('terms.s6P')}</p>
          </section>

          {/* ── #postanowienia ───────────────────────────────────── */}
          <section id="postanowienia">
            <h2>{t('terms.s7H')}</h2>
            <p>{t('terms.s7P')}</p>
          </section>
        </div>
      </div>
    </main>
  );
}
