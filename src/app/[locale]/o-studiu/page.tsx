import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { SectionHead } from '@/components/ui/SectionHead';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('title.studio') };
}

/** Studio / about. Sections: page-head, story, facts, process, CTA. */
export default async function StudioPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  return (
    <main>
      {/* ── PAGE HEAD ────────────────────────────────────────────── */}
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('studio.eyebrow')}</div>
          <h1>{t.rich('studio.h1', richTags)}</h1>
          <p className="lead">{t('studio.lead')}</p>
        </div>
      </section>

      {/* ── HISTORIA ─────────────────────────────────────────────── */}
      <section className="section">
        <div className="section-inner">
          <div className="story">
            <div className="story-art">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/uploads/waza-mala-1.webp" alt="" />
              <span className="signature">Anna</span>
            </div>
            <div className="story-text">
              <div className="section-eyebrow">{t('studio.storyEyebrow')}</div>
              <h2 className="section-title">{t.rich('studio.storyH', richTags)}</h2>
              <p>{t('studio.storyP1')}</p>
              <p>{t('studio.storyP2')}</p>
              <p>{t('studio.storyP3')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── DETALE PRACOWNI ──────────────────────────────────────── */}
      <section className="section facts">
        <div className="section-inner">
          <SectionHead
            eyebrow={t('studio.factsEyebrow')}
            title={t.rich('studio.factsH', richTags)}
          />
          <div className="facts-grid">
            <div className="fact">
              <div className="k">{t('studio.fact1K')}</div>
              <div className="v">{t.rich('studio.fact1V', richTags)}</div>
              <div className="d">{t('studio.fact1D')}</div>
            </div>
            <div className="fact">
              <div className="k">{t('studio.fact2K')}</div>
              <div className="v">{t.rich('studio.fact2V', richTags)}</div>
              <div className="d">{t('studio.fact2D')}</div>
            </div>
            <div className="fact">
              <div className="k">{t('studio.fact3K')}</div>
              <div className="v">{t.rich('studio.fact3V', richTags)}</div>
              <div className="d">{t('studio.fact3D')}</div>
            </div>
            <div className="fact">
              <div className="k">{t('studio.fact4K')}</div>
              <div className="v">{t.rich('studio.fact4V', richTags)}</div>
              <div className="d">{t('studio.fact4D')}</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── JAK POWSTAJE PRACA ───────────────────────────────────── */}
      <section className="section craft" id="proces">
        <div className="section-inner">
          <SectionHead
            eyebrow={t('studio.procEyebrow')}
            title={t.rich('studio.procH', richTags)}
          />
          <div className="craft-grid">
            <div className="craft-item">
              <div className="num">01</div>
              <h4>{t.rich('studio.p1H', richTags)}</h4>
              <p>{t('studio.p1P')}</p>
            </div>
            <div className="craft-item">
              <div className="num">02</div>
              <h4>{t.rich('studio.p2H', richTags)}</h4>
              <p>{t('studio.p2P')}</p>
            </div>
            <div className="craft-item">
              <div className="num">03</div>
              <h4>{t.rich('studio.p3H', richTags)}</h4>
              <p>{t('studio.p3P')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA BAND ─────────────────────────────────────────────── */}
      <section className="section cta-band">
        <div className="cta-band-inner">
          <h2>{t.rich('studio.ctaH', richTags)}</h2>
          <p>{t('studio.ctaP')}</p>
          <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" href="/kubki">
              <span>{t('studio.ctaB1')}</span> <Icon name="arrow" className="btn-arrow" />
            </Link>
            <Link className="btn btn-ghost" href="/wazony">
              {t('studio.ctaB2')}
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
