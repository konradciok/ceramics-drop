import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Marquee } from '@/components/ui/Marquee';
import { SectionHead } from '@/components/ui/SectionHead';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { HomeHero, HOME_DROP_LIST_ID } from '@/components/shop/HomeHero';
import { FooterNewsletterForm } from '@/components/layout/FooterNewsletterForm';
import { CollectionCard } from '@/components/shop/CollectionCard';
import { Gallery } from '@/components/shop/Gallery';
import { ShopFamilyChips } from '@/components/shop/ShopFamilyChips';
import { pickHomePieces } from '@/lib/home-pieces';
import { loadCeramicShopProducts, summariseCeramicShop } from '@/components/shop/CeramicShopScreen';
import { CATEGORIES } from '@/lib/products';
import { StripUrlToken } from '@/components/shop/StripUrlToken';
import { srcSet } from '@/lib/images';
import { alternatesFor } from '@/lib/seo/urls';
import { previewRobots } from '@/lib/seo/robots';
import type { Locale } from '@/i18n/routing';
import { requireLocale } from '@/i18n/locale-guard';
import { EMAIL } from '@/lib/email-addresses';
import { STUDIO_PICKUP_ENABLED } from '@/lib/pricing';
import {
  HOME_EDITORIAL_DESKTOP_IMAGE,
  HOME_EDITORIAL_MOBILE_IMAGE,
  HOME_STORY_IMAGE,
  EDITORIAL_IMAGES,
} from '@/lib/editorial-images';
import { getHomeContent } from '@/lib/cms/home';
import type { CmsLocale } from '@/lib/cms/types';

// Catalog visibility and sold state are database-owned in production. Keep
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

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale = requireLocale((await params).locale);
  const previewParam = (await searchParams)?.preview;
  const t = await getTranslations({ locale });
  // Home title already leads with the brand, so opt out of the layout's
  // "%s — Anna Ciok Studio" template to avoid doubling it.
  return {
    title: { absolute: t('title.home') },
    alternates: alternatesFor(locale as Locale, '/'),
    robots: previewRobots(previewParam),
  };
}

/**
 * Home — full-bleed CMS-driven hero (image or video, admin-editable copy,
 * messages fallback), then a row of purchasable pieces from the live drop
 * (with prices, add-to-cart on the tile), then a ceramics-first narrative: a
 * fact marquee, the drop-list signup the hero links to, the artist's practice,
 * a card per ceramic family, a 3-step how-to-buy guide, editorial imagery, and
 * contact.
 */
export default async function HomePage({ params, searchParams }: Props) {
  // Dotted paths skip the i18n middleware and reach this page with a junk
  // segment — 404 before touching any locale-keyed table (see locale-guard).
  const locale = requireLocale((await params).locale);
  const previewParam = (await searchParams)?.preview;
  const previewToken = typeof previewParam === 'string' ? previewParam : undefined;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });
  const editorialImage = HOME_EDITORIAL_MOBILE_IMAGE;
  const editorialDesktopImage = HOME_EDITORIAL_DESKTOP_IMAGE;
  const storyImage = HOME_STORY_IMAGE;

  const [heroContent, products] = await Promise.all([
    getHomeContent(locale as CmsLocale, previewToken),
    // Best-effort: the piece row and the family grid simply disappear on a
    // cold catalogue failure rather than taking the homepage down.
    loadCeramicShopProducts().catch(() => []),
  ]);
  const { available, families } = summariseCeramicShop(products);
  const homePieces = pickHomePieces(available);

  return (
    <main>
      <StripUrlToken names={['preview']} />
      {/* ── HERO ─────────────────────────────────────────────────── */}
      <HomeHero
        content={heroContent}
        fallbackImage={HOME_HERO_FALLBACK_IMAGE}
        dropListCta={t('newsletter.nextDropCta')}
      />

      {/* ── AVAILABLE NOW — purchasable pieces of the live drop, with prices ── */}
      {homePieces.length > 0 && (
        <section className="section home-pieces" data-testid="home-pieces">
          <div className="section-inner">
            <SectionHead
              eyebrow={t('home.piecesEyebrow')}
              title={t.rich('home.piecesTitle', richTags)}
              aside={
                <div className="prints-home-aside">
                  <p>{t('home.piecesLead')}</p>
                  <Link className="section-link" href="/sklep">
                    <span>{t('home.piecesCta')}</span> <Icon name="arrow" />
                  </Link>
                </div>
              }
            />
            <div className="home-family-chips">
              <ShopFamilyChips families={families} />
            </div>
          </div>
          <Gallery products={homePieces} listId="home" filterable={false} />
        </section>
      )}

      {/* ── MARQUEE ──────────────────────────────────────────────── */}
      <Marquee items={t.raw('home.marquee') as string[]} />

      {/* ── DROP LIST — the hero's secondary action lands here ───── */}
      <section className="section drop-list-band" id={HOME_DROP_LIST_ID} data-testid="home-drop-list">
        <div className="section-inner drop-list-band-inner">
          <h2 className="section-title">{t('newsletter.nextDropHeading')}</h2>
          <FooterNewsletterForm placement="home_hero" />
        </div>
      </section>

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
                <Link className="btn btn-primary" href="/sklep">
                  <span>{t('home.storyCta')}</span> <Icon name="arrow" className="btn-arrow" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CERAMIC FAMILIES — one card per category ─────────────── */}
      {families.length > 0 && (
        <section className="section collections-hub reveal" data-testid="home-families">
          <div className="section-inner">
            <SectionHead
              eyebrow={t('home.collectionsEyebrow')}
              title={t.rich('home.collectionsTitle', richTags)}
              aside={
                <div className="prints-home-aside">
                  <p>{t('home.collectionsLead')}</p>
                  <Link className="section-link" href="/sklep">
                    <span>{t('home.collectionsCta')}</span> <Icon name="arrow" />
                  </Link>
                </div>
              }
            />
            <div className="collections-hub-grid">
              {families.map((f) =>
                f.cover ? (
                  <CollectionCard
                    key={f.slug}
                    href={`/${f.slug}`}
                    name={t(CATEGORIES[f.slug].nameKey)}
                    image={f.cover}
                    countLabel={t('ceramicShop.familyCount', { count: f.total, available: f.available })}
                    sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
                  />
                ) : null,
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── HOW TO BUY — pick a piece → packed by hand → delivery ──── */}
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
              <h4>{t.rich(STUDIO_PICKUP_ENABLED ? 'home.craft3H' : 'home.craft3HShipOnly', richTags)}</h4>
              <p>{t(STUDIO_PICKUP_ENABLED ? 'home.craft3P' : 'home.craft3PShipOnly')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── EDITORIAL ────────────────────────────────────────────── */}
      <section className="section editorial reveal">
        <div className="section-inner">
          <div className="editorial-shot">
            {/* Art direction: horizontal interior shot on desktop, vertical on
                mobile — same `<picture>` pattern as the HomeHero. */}
            <picture>
              <source
                media="(min-width:861px)"
                srcSet={srcSet(editorialDesktopImage.src)}
                sizes="(min-width:861px) 720px"
              />
              <img
                src={editorialImage.src}
                srcSet={srcSet(editorialImage.src)}
                sizes="100vw"
                alt={t('home.editorialImageAlt')}
                width={editorialImage.width}
                height={editorialImage.height}
              />
            </picture>
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
          </div>
        </div>
      </section>
    </main>
  );
}
