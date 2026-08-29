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
import { CATEGORIES, VISIBLE_CATEGORY_ORDER, getPublicProducts } from '@/lib/products';
import type { CategorySlug, PrintDesign, Product } from '@/lib/types';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { getPrintPricingConfig } from '@/lib/print-pricing-config/get';
import { fromPriceOf } from '@/lib/print-pricing';
import { mockupSrc, printListingImage, withRegistryMockups, type MockupState } from '@/lib/print-mockups';
import { dateKey, pickDaily } from '@/lib/print-rotation';
import { srcSet } from '@/lib/images';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';
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

type Props = {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ preview?: string | string[] }>;
};

const COVER: Record<CategorySlug, string> = {
  kubki: '/uploads/kubek-12.webp',
  wazony: '/uploads/waza-mala-3.webp',
  'wazony-srednie': '/uploads/waza-duza-1.webp',
  'wazony-duze': '/uploads/waza-duza-7.webp',
  talerzyki: '/uploads/talerz-maly-2.webp',
  'talerze-srednie': '/uploads/sredni-talerz-17.webp',
  'talerze-duze': '/uploads/talerz-duzy-1.webp',
  'duze-michy': '/uploads/duza-micha-1.webp',
  'miski-falowane': '/uploads/miski-falowane-9.webp',
  // ponytail: placeholder until Task 16 adds a real prints cover image
  'fine-art-prints': '/uploads/kubek-12.webp',
};

/* Curated home picks (design canvas "Jedna pracownia, dwa media"). Frame
   colours vary on purpose — the rail hints at the configurator. Every pick
   degrades gracefully: a missing/unpublished id is skipped and backfilled
   from registry order, so a catalog edit can never blank the section. */
const PRINT_RAIL: { id: string; state: MockupState }[] = [
  { id: 'fap001', state: 'framed-natural' },
  { id: 'fap002', state: 'framed-natural' },
  { id: 'fap011', state: 'framed-black' },
  { id: 'fap015', state: 'framed-brown' },
];

/** Mockup in a specific frame colour, falling back to the design's default
    listing presentation (framed-natural mockup or the plain artwork). */
function railImage(design: PrintDesign, state: MockupState): string {
  const merged = withRegistryMockups(design, registryPrintById(design.id));
  return mockupSrc(merged, state) ?? printListingImage(design, registryPrintById(design.id));
}


export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale } = await params;
  const previewParam = (await searchParams)?.preview;
  const t = await getTranslations({ locale });
  // Home title already leads with the brand, so opt out of the layout's
  // "%s — Anna Ciok Ceramics" template to avoid doubling it.
  return {
    title: { absolute: t('title.home') },
    alternates: alternatesFor(locale as Locale, '/'),
    // Any ?preview= URL is an admin-only draft view — never indexable, even
    // if the token is invalid (the body would just fall back to published copy),
    // and even if Next.js delivered it as an array (repeated ?preview= keys).
    robots: previewParam !== undefined ? { index: false, follow: false } : undefined,
  };
}

/**
 * Home — full-bleed CMS-driven hero (image or video, admin-editable copy,
 * messages fallback), painting-reveal beat, marquee, ceramic collections,
 * fine-art-print rail, studio story, "how it works", split logistics band,
 * contact.
 */
export default async function HomePage({ params, searchParams }: Props) {
  const { locale } = await params;
  const previewParam = (await searchParams)?.preview;
  const previewToken = typeof previewParam === 'string' ? previewParam : undefined;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });
  const editorialImage = HOME_EDITORIAL_IMAGE;
  const storyImage = HOME_STORY_IMAGE;

  // Counts and prices are derived, never copy — the audited home page showed
  // stale hard-coded prices in every locale (and different counts in German).
  // Counts are the archival drop size per category (sold/showroom included).
  const currency = await getCurrency(locale);
  const { fmt } = currencyFormatter(currency);
  const [products, printDesigns, printPricing, heroContent] = await Promise.all([
    getPublicProducts(),
    getPrintDesigns(),
    getPrintPricingConfig(),
    getHomeContent(locale as CmsLocale, previewToken),
  ]);
  const byCategory = new Map<CategorySlug, Product[]>();
  for (const p of products) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  // Prints are chargeable in EUR/GBP/PLN only — same clamp as the print PDPs.
  const printCurrency = toChargeableCurrency(currency);
  const { fmt: fmtPrint } = currencyFormatter(printCurrency);
  const printById = new Map(printDesigns.map((d) => [d.id, d]));
  const railPicked = PRINT_RAIL.flatMap(({ id, state }) => {
    const d = printById.get(id);
    return d ? [{ design: d, image: railImage(d, state) }] : [];
  });
  const railFill = printDesigns
    .filter((d) => !railPicked.some((r) => r.design.id === d.id))
    .slice(0, Math.max(0, PRINT_RAIL.length - railPicked.length))
    .map((d) => ({ design: d, image: printListingImage(d, registryPrintById(d.id)) }));
  const railPrints = [...railPicked, ...railFill];
  const printName = (d: PrintDesign) => `${t('product.print')} Nº ${d.num}`;

  // Hero-beat carousel: 5 daily-rotated prints, never overlapping the curated
  // rail below. Dynamic catalog routes compute the date at request time.
  const railIds = new Set(railPrints.map((r) => r.design.id));
  const heroBeatPrints = pickDaily(printDesigns, { count: 5, dateKey: dateKey(), exclude: railIds })
    .map((d) => ({ design: d, image: railImage(d, 'framed-natural') }));

  return (
    <main>
      <StripUrlToken names={['preview']} />
      {/* ── HERO ─────────────────────────────────────────────────── */}
      <HomeHero content={heroContent} fallbackImage={HOME_HERO_FALLBACK_IMAGE} />

      {/* ── HERO BEAT 2 — daily-rotated print tiles ──────────────── */}
      <section className="hero-beat">
        <div className="hero-beat-inner">
          {heroBeatPrints.length > 0 && (
            <div className="hero-beat-grid reveal">
              {heroBeatPrints.map(({ design: d, image }) => (
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
          )}
          <p className="hero-beat-cap reveal">{t('home.heroBeatCap', { count: printDesigns.length })}</p>
        </div>
      </section>

      {/* ── MARQUEE ──────────────────────────────────────────────── */}
      <Marquee items={t.raw('home.marquee') as string[]} />

      {/* ── COLLECTIONS ──────────────────────────────────────────── */}
      <section className="section collections reveal">
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
            {VISIBLE_CATEGORY_ORDER.map((slug) => {
              const cat = CATEGORIES[slug];
              const sk = cat.singularKey;
              const pieces = byCategory.get(slug) ?? [];
              if (pieces.length === 0) return null;
              return (
                <Link key={slug} className="collection" href={`/${slug}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={COVER[slug]} srcSet={srcSet(COVER[slug])} sizes="(min-width:861px) 50vw, 100vw" alt="" />
                  <div className="shade"></div>
                  <div className="col-content">
                    <div className="num">
                      {t(`home.card.${sk}.num`, {
                        count: pieces.length,
                        price: fmt(priceOfCurrency(pieces[0], currency)),
                      })}
                    </div>
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
          <div className="home-more">
            <Link className="section-link" href="/sklep">
              <span>{t('home.colAllCta')}</span> <Icon name="arrow" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── PRINTS — paintings in fine art editions ──────────────── */}
      {railPrints.length > 0 && (
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
              {railPrints.map(({ design: d, image }) => (
                <PrintCard
                  key={d.id}
                  id={d.id}
                  image={image}
                  name={printName(d)}
                  priceLabel={t('print.from', { price: fmtPrint(fromPriceOf(d, printCurrency, printPricing)) })}
                  sizes="(min-width:861px) 25vw, 60vw"
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

      {/* ── EDITORIAL ────────────────────────────────────────────── */}
      <section className="section editorial reveal">
        <div className="section-inner">
          <div className="editorial-shot">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={editorialImage.src} srcSet={srcSet(editorialImage.src)} sizes="(min-width:861px) 720px, 100vw" alt={t('home.editorialImageAlt')} width={editorialImage.width} height={editorialImage.height} />
          </div>
        </div>
      </section>

      {/* ── STUDIO STORY ─────────────────────────────────────────── */}
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
                <Link className="btn btn-primary" href="/sklep">
                  <span>{t('home.storyCta1')}</span> <Icon name="arrow" className="btn-arrow" />
                </Link>
                <Link className="btn btn-ghost" href="/fine-art-prints">
                  {t('home.storyCta2')}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CRAFT / JAK TO DZIAŁA ────────────────────────────────── */}
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

      {/* ── LOGISTICS — split shipping band (ceramics PL / prints EU) ─ */}
      <section className="logistics">
        <div className="logistics-inner">
          <div>
            <h3>{t('home.lgCeramicH')}</h3>
            <p>{t('home.lgCeramicP')}</p>
          </div>
          <div className="logistics-divider" aria-hidden="true"></div>
          <div>
            <h3>{t('home.lgPrintsH')}</h3>
            <p>{t('home.lgPrintsP')}</p>
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
              <span className="lbl">{t('home.ctLShip')}</span>
              <span className="val">{t('home.ctVShip')}</span>
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
