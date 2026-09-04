import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Marquee } from '@/components/ui/Marquee';
import { SectionHead } from '@/components/ui/SectionHead';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { HomeHero } from '@/components/shop/HomeHero';
import { PrintCard } from '@/components/shop/PrintCard';
import { StripUrlToken } from '@/components/shop/StripUrlToken';
import type { PrintDesign } from '@/lib/types';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { getPrintPricingConfig } from '@/lib/print-pricing-config/get';
import { fromPriceOf } from '@/lib/print-pricing';
import { groupPrintDesigns } from '@/lib/print-collections';
import { mockupSrc, printListingImage, withRegistryMockups, type MockupState } from '@/lib/print-mockups';
import { dateKey, pickDaily } from '@/lib/print-rotation';
import { srcSet } from '@/lib/images';
import { alternatesFor } from '@/lib/seo/urls';
import { previewRobots } from '@/lib/seo/robots';
import type { Locale } from '@/i18n/routing';
import { requireLocale } from '@/i18n/locale-guard';
import { EMAIL } from '@/lib/email-addresses';
import { HOME_EDITORIAL_IMAGE, HOME_STORY_IMAGE, EDITORIAL_IMAGES } from '@/lib/editorial-images';
import { getHomeContent } from '@/lib/cms/home';
import type { CmsLocale } from '@/lib/cms/types';

// Catalog visibility and print pricing are database-owned in production. Keep
// the locale route server-rendered so a deploy can never freeze code-mode build
// data into the homepage indefinitely.
export const dynamic = 'force-dynamic';

/** Committed static default for either hero slot when the CMS has no media
    published — a warm studio-workspace shot, distinct from the editorial and
    story photos used further down this page. */
const HOME_HERO_FALLBACK_IMAGE = EDITORIAL_IMAGES.aniaWorkspace;

/** How many designs the daily-rotated print rail shows. Dynamic catalog
    routes compute the date-seeded pick at request time. */
const DAILY_RAIL_COUNT = 5;

type Props = {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ preview?: string | string[] }>;
};

/** Mockup in a specific frame colour, falling back to the design's default
    listing presentation (framed-natural mockup or the plain artwork). */
function railImage(design: PrintDesign, state: MockupState): string {
  const merged = withRegistryMockups(design, registryPrintById(design.id));
  return mockupSrc(merged, state) ?? printListingImage(design, registryPrintById(design.id));
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale = requireLocale((await params).locale);
  const previewParam = (await searchParams)?.preview;
  const t = await getTranslations({ locale });
  // Home title already leads with the brand, so opt out of the layout's
  // "%s — Anna Ciok Ceramics" template to avoid doubling it.
  return {
    title: { absolute: t('title.home') },
    alternates: alternatesFor(locale as Locale, '/'),
    robots: previewRobots(previewParam),
  };
}

/**
 * Home — full-bleed CMS-driven hero (image or video, admin-editable copy,
 * messages fallback), print-first narrative below it: a fact marquee, the
 * artist's painting practice, the nine named print collections, a
 * daily-rotated print rail, a 3-step ordering guide, editorial imagery, a
 * print-only logistics band, and contact. Ceramics keep their own routes
 * (/sklep, category pages) but are not promoted on this page.
 */
export default async function HomePage({ params, searchParams }: Props) {
  // Dotted paths skip the i18n middleware and reach this page with a junk
  // segment — 404 before touching any locale-keyed table (see locale-guard).
  const locale = requireLocale((await params).locale);
  const previewParam = (await searchParams)?.preview;
  const previewToken = typeof previewParam === 'string' ? previewParam : undefined;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });
  const editorialImage = HOME_EDITORIAL_IMAGE;
  const storyImage = HOME_STORY_IMAGE;

  const currency = await getCurrency(locale);
  const [printDesigns, printPricing, heroContent] = await Promise.all([
    getPrintDesigns(),
    getPrintPricingConfig(),
    getHomeContent(locale as CmsLocale, previewToken),
  ]);

  // Prints are chargeable in EUR/GBP/PLN only — same clamp as the print PDPs.
  const printCurrency = toChargeableCurrency(currency);
  const { fmt: fmtPrint } = currencyFormatter(printCurrency);
  const printName = (d: PrintDesign) => `${t('product.print')} Nº ${d.num}`;

  // Nine named collections (plus an "inne" fallback bucket, only if
  // non-empty) — membership/order come from groupPrintDesigns, never
  // hardcoded here. Empty collections are already dropped upstream.
  const collectionGroups = groupPrintDesigns(printDesigns);

  // Daily-rotated print rail — the same seeded-shuffle mechanism the
  // homepage has always used, now the page's single scrolling rail.
  const dailyRailPrints = pickDaily(printDesigns, { count: DAILY_RAIL_COUNT, dateKey: dateKey() })
    .map((d) => ({ design: d, image: railImage(d, 'framed-natural') }));

  return (
    <main>
      <StripUrlToken names={['preview']} />
      {/* ── HERO ─────────────────────────────────────────────────── */}
      <HomeHero content={heroContent} fallbackImage={HOME_HERO_FALLBACK_IMAGE} />

      {/* ── MARQUEE ──────────────────────────────────────────────── */}
      <Marquee items={t.raw('home.marquee') as string[]} />

      {/* ── STUDIO STORY — Anna's painting practice ─────────────── */}
      <section className="section reveal" id="studio">
        <div className="section-inner">
          <div className="story">
            <div className="story-art">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={storyImage.src} srcSet={srcSet(storyImage.src)} sizes="(min-width:861px) 50vw, 100vw" alt={t('home.storyImageAlt')} width={storyImage.width} height={storyImage.height} />
            </div>
            <div className="story-text">
              <div className="section-eyebrow">{t('home.storyEyebrow')}</div>
              <h2 className="section-title">{t.rich('home.storyTitle', richTags)}</h2>
              <p>{t('home.storyP1')}</p>
              <p>{t('home.storyP2')}</p>
              <div className="story-actions">
                <Link className="btn btn-primary" href="/fine-art-prints">
                  <span>{t('home.storyCta')}</span> <Icon name="arrow" className="btn-arrow" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── COLLECTIONS INDEX — the nine named print collections ─── */}
      {collectionGroups.length > 0 && (
        <section className="section print-collections reveal">
          <div className="section-inner">
            <SectionHead
              eyebrow={t('home.collectionsEyebrow')}
              title={t.rich('home.collectionsTitle', richTags)}
              aside={
                <div className="prints-home-aside">
                  <p>{t('home.collectionsLead')}</p>
                  <Link className="section-link" href="/fine-art-prints">
                    <span>{t('home.collectionsCta')}</span> <Icon name="arrow" />
                  </Link>
                </div>
              }
            />
            <div className="print-collections-grid">
              {collectionGroups.map((g) => {
                const cover = printListingImage(g.designs[0], registryPrintById(g.designs[0].id));
                const name = g.name ?? t('printCollections.inne');
                return (
                  <Link key={g.slug} className="prints-home-card" href={`/fine-art-prints#${g.slug}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cover} srcSet={srcSet(cover)} sizes="(min-width:861px) 30vw, 45vw" alt="" loading="lazy" />
                    <span className="prints-home-meta">
                      <span className="nm">{name}</span>
                      <span className="pr">{t('home.collectionsCount', { count: g.designs.length })}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* ── PRINTS — daily-rotated selection of paintings ─────────── */}
      {dailyRailPrints.length > 0 && (
        <section className="section prints-home reveal">
          <div className="section-inner">
            <SectionHead
              eyebrow={t('home.printsEyebrow')}
              title={t.rich('home.printsTitle', richTags)}
              aside={
                <div className="prints-home-aside">
                  <p>{t('home.printsLead', { count: printDesigns.length })}</p>
                  <Link className="section-link" href="/fine-art-prints">
                    <span>{t('home.printsCta')}</span> <Icon name="arrow" />
                  </Link>
                </div>
              }
            />
            <div className="prints-home-grid">
              {dailyRailPrints.map(({ design: d, image }) => (
                <PrintCard
                  key={d.id}
                  id={d.id}
                  image={image}
                  name={printName(d)}
                  priceLabel={t('print.from', { price: fmtPrint(fromPriceOf(d, printCurrency, printPricing)) })}
                  sizes="(min-width:861px) 20vw, 60vw"
                />
              ))}
            </div>
            <div className="prints-home-facts">
              {(t.raw('home.printsFacts') as string[]).map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── FORMAT & ORDERING — wybór formatu/oprawy → zakup ──────── */}
      <section className="section craft reveal" id="jak">
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

      {/* ── EDITORIAL ────────────────────────────────────────────── */}
      <section className="section editorial reveal">
        <div className="section-inner">
          <div className="editorial-shot">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={editorialImage.src} srcSet={srcSet(editorialImage.src)} sizes="(min-width:861px) 720px, 100vw" alt={t('home.editorialImageAlt')} width={editorialImage.width} height={editorialImage.height} />
          </div>
        </div>
      </section>

      {/* ── LOGISTICS — material + realisation & shipping (prints only) ─ */}
      <section className="logistics">
        <div className="logistics-inner">
          <div>
            <h3>{t('home.lgMaterialH')}</h3>
            <p>{t('home.lgMaterialP')}</p>
          </div>
          <div className="logistics-divider" aria-hidden="true"></div>
          <div>
            <h3>{t('home.lgShippingH')}</h3>
            <p>{t('home.lgShippingP')}</p>
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
            <a className="btn btn-primary" href={`mailto:${EMAIL.contact}`}>
              <span>{t('home.ctBtn')}</span> <Icon name="arrow" className="btn-arrow" />
            </a>
          </div>
          <div className="contact-list">
            <div className="contact-row">
              <span className="lbl">{t('home.ctLEmail')}</span>
              <span className="val">{EMAIL.contact}</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('home.ctLIg')}</span>
              <span className="val">{t('home.ctVIg')}</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('home.ctLShipPrints')}</span>
              <span className="val">{t('home.ctVShipPrints')}</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
