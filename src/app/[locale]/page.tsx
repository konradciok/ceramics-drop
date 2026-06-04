import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Marquee } from '@/components/ui/Marquee';
import { SectionHead } from '@/components/ui/SectionHead';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { CATEGORIES, CATEGORY_ORDER } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';
import { pln } from '@/lib/format';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';

type Props = { params: Promise<{ locale: string }> };

const COVER: Record<CategorySlug, string> = {
  kubki: '/uploads/kubek-12.webp',
  wazony: '/uploads/waza-mala-3.webp',
  'wazony-duze': '/uploads/waza-duza-7.webp',
  talerzyki: '/uploads/talerz-maly-2.webp',
  'talerze-duze': '/uploads/talerz-duzy-1.webp',
  'duze-michy': '/uploads/duza-micha-1.webp',
  'miski-falowane': '/uploads/miski-falowane-9.webp',
};


export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.home'),
    alternates: alternatesFor(locale as Locale, '/'),
  };
}

/**
 * Home. Content phase: hero, marquee, collections grid, studio story,
 * "how it works", contact — see design/index.html.
 */
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  return (
    <main>
      {/* ── HERO ─────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <div className="eyebrow hero-eyebrow">{t('home.heroEyebrow')}</div>
            <h1 className="hero-title">{t.rich('home.heroTitle', richTags)}</h1>
            <p className="hero-sub">{t('home.heroSub')}</p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/kubki">
                <span>{t('home.heroCta1')}</span> <Icon name="arrow" className="btn-arrow" />
              </Link>
              <Link className="btn btn-ghost" href="/wazony">
                {t('home.heroCta2')}
              </Link>
            </div>
          </div>
          <div className="hero-art">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/uploads/kubek-2.webp" alt="" width={1600} height={2000} fetchPriority="high" />
            <div className="hero-art-meta">
              <span className="left">
                <span className="mt">{t('home.heroMetaName')}</span>
                <br />
                <span>{t('home.heroMetaDesc')}</span>
              </span>
              <span className="right">{pln(90)}</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── MARQUEE ──────────────────────────────────────────────── */}
      <Marquee items={t.raw('home.marquee') as string[]} />

      {/* ── COLLECTIONS ──────────────────────────────────────────── */}
      <section className="section collections">
        <div className="section-inner">
          <SectionHead
            eyebrow={t('home.colEyebrow')}
            title={t.rich('home.colTitle', richTags)}
            aside={
              <p style={{ maxWidth: '34ch', opacity: 0.8, fontSize: 16, lineHeight: 1.6, margin: 0 }}>
                {t('home.colLead')}
              </p>
            }
          />
          <div className="collection-grid">
            {CATEGORY_ORDER.map((slug) => {
              const cat = CATEGORIES[slug];
              const sk = cat.singularKey;
              return (
                <Link key={slug} className="collection" href={`/${slug}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={COVER[slug]} alt="" />
                  <div className="shade"></div>
                  <div className="col-content">
                    <div className="num">{t(`home.card.${sk}.num`)}</div>
                    <h3>{t(cat.nameKey)}</h3>
                    <p>{t(`home.card.${sk}.desc`)}</p>
                    <span className="col-cta">
                      <span>{t(`home.card.${sk}.cta`)}</span> <Icon name="arrow" />
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── STUDIO STORY ─────────────────────────────────────────── */}
      <section className="section" id="studio">
        <div className="section-inner">
          <div className="story">
            <div className="story-art">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/uploads/waza-mala-1.webp" alt="" width={1600} height={2000} />
              <span className="signature">Anna</span>
            </div>
            <div className="story-text">
              <div className="section-eyebrow">{t('home.storyEyebrow')}</div>
              <h2 className="section-title">{t.rich('home.storyTitle', richTags)}</h2>
              <p>{t('home.storyP1')}</p>
              <p>{t('home.storyP2')}</p>
              <p>{t('home.storyP3')}</p>
              <div className="story-actions">
                <Link className="btn btn-primary" href="/kubki">
                  <span>{t('home.storyCta1')}</span> <Icon name="arrow" className="btn-arrow" />
                </Link>
                <Link className="btn btn-ghost" href="/kontakt">
                  {t('home.storyCta2')}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CRAFT / JAK TO DZIAŁA ────────────────────────────────── */}
      <section className="section craft" id="jak">
        <div className="section-inner">
          <SectionHead
            eyebrow={t('home.craftEyebrow')}
            title={t.rich('home.craftTitle', richTags)}
          />
          <div className="craft-grid">
            <div className="craft-item">
              <div className="num">01</div>
              <h4>{t.rich('home.craft1H', richTags)}</h4>
              <p>{t('home.craft1P')}</p>
            </div>
            <div className="craft-item">
              <div className="num">02</div>
              <h4>{t.rich('home.craft2H', richTags)}</h4>
              <p>{t('home.craft2P')}</p>
            </div>
            <div className="craft-item">
              <div className="num">03</div>
              <h4>{t.rich('home.craft3H', richTags)}</h4>
              <p>{t('home.craft3P')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CONTACT BAND ─────────────────────────────────────────── */}
      <section className="section contact" id="kontakt">
        <div className="contact-inner">
          <div>
            <div className="section-eyebrow">{t('home.ctEyebrow')}</div>
            <h3>{t.rich('home.ctH', richTags)}</h3>
            <p>{t('home.ctP')}</p>
            <a className="btn btn-primary" href="mailto:hej@annaciok.pl">
              <span>{t('home.ctBtn')}</span> <Icon name="arrow" className="btn-arrow" />
            </a>
          </div>
          <div className="contact-list">
            <div className="contact-row">
              <span className="lbl">{t('home.ctLEmail')}</span>
              <span className="val">hej@annaciok.pl</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('home.ctLIg')}</span>
              <span className="val">{t('home.ctVIg')}</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('home.ctLStudio')}</span>
              <span className="val">{t('home.ctVStudio')}</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('home.ctLShip')}</span>
              <span className="val">{t('home.ctVShip')}</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
