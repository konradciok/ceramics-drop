import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { alternatesFor } from '@/lib/seo/urls';
import { getSoldIds } from '@/lib/inventory';
import { LOOKS } from '@/lib/looks';
import { LookBlock } from '@/components/editorial/LookBlock';
import type { Locale } from '@/i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.inspiracje'),
    description: t('inspiracje.metaDesc'),
    alternates: alternatesFor(locale as Locale, '/inspiracje'),
    openGraph: {
      images: LOOKS[0]?.image ? [{ url: LOOKS[0].image }] : [],
    },
  };
}

export default async function InspiracjePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });

  // Sold state — same source collection pages use, merged at render. A DB blip
  // must not break the editorial page, so degrade to "all available" on error.
  let soldIds = new Set<string>();
  try {
    soldIds = new Set(await getSoldIds());
  } catch {
    soldIds = new Set<string>();
  }

  return (
    <main>
      {/* ── PAGE HEADER ──────────────────────────────────────── */}
      {/*
        page-head-inner is a 1fr 1.05fr grid at ≥861px (copy + art). This page
        has no art column, so force single-column via inline style; the rest of
        page-head styling (padding, background, h1 font) still applies.
      */}
      <section className="page-head">
        <div className="page-head-inner" style={{ gridTemplateColumns: '1fr' }}>
          <div className="page-head-copy">
            <div className="eyebrow">{t('inspiracje.eyebrow')}</div>
            <h1>{t('inspiracje.h1')}</h1>
            <p className="lead">{t('inspiracje.intro')}</p>
          </div>
        </div>
      </section>

      {/* ── LOOK BLOCKS ──────────────────────────────────────── */}
      <div className="section-inner">
        {LOOKS.map((look, i) => (
          <LookBlock
            key={look.id}
            look={look}
            index={i}
            locale={locale as Locale}
            soldIds={soldIds}
          />
        ))}

        {LOOKS.length === 0 && (
          <p
            style={{
              padding: 'var(--section-y) 0',
              color: 'var(--c-line)',
              textAlign: 'center',
            }}
          >
            {t('inspiracje.comingSoon')}
          </p>
        )}
      </div>

      {/* ── CTA BAND ─────────────────────────────────────────── */}
      <section className="section cta-band">
        <div className="cta-band-inner">
          <h2>{t('inspiracje.ctaH')}</h2>
          <Link className="btn btn-primary" href="/sklep">
            <span>{t('inspiracje.ctaBtn')}</span>
            <Icon name="arrow" className="btn-arrow" />
          </Link>
        </div>
      </section>
    </main>
  );
}
