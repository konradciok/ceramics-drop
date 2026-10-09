import '@/styles/market.css';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation';
import { requireLocale } from '@/i18n/locale-guard';
import { Icon } from '@/components/ui/Icon';
import { Marquee } from '@/components/ui/Marquee';
import { SectionHead } from '@/components/ui/SectionHead';
import {
  GalleryTrigger,
  MarketGalleryProvider,
  type MarketGalleries,
  type MarketGalleryItem,
} from '@/components/market/MarketGallery';
import { srcSet } from '@/lib/images';
import {
  MARKET_ENGAGEMENT,
  MARKET_EVENT,
  MARKET_IMAGES,
  MARKET_LOCALE,
  MARKET_LOOKBOOK,
  MARKET_PATH,
  MARKET_PLATE_WALL,
  MARKET_SHOWROOM_ALT,
  MARKET_SHOWROOM_IDS,
  marketCalendarUrl,
  marketMapsUrl,
  showroomImageSize,
} from '@/lib/market-event';
import { getCategory, productDisplayName, registryProductById } from '@/lib/products';
import { absoluteUrl } from '@/lib/seo/urls';
import { SITE_URL } from '@/lib/site';

type Props = { params: Promise<{ locale: string }> };

const DESCRIPTION =
  'Hand-painted ceramics and fine art prints by Anna Ciok at the El Médano handicraft market — Saturday 10 October 2026, 9:00–14:00, main plaza. A one-of-a-kind souvenir from Tenerife.';

const SHOWROOM_NOTE =
  'From an earlier collection — one of a kind, hand-painted in my studio in Güímar. Come see what’s on the table on Saturday.';

const MARQUEE = ['hand-painted plates', 'mugs & vases', 'fine art prints', 'one of a kind', 'made in Tenerife'];

export async function generateMetadata(): Promise<Metadata> {
  const hero = MARKET_IMAGES.printsPlate;
  return {
    title: `El Médano market · ${MARKET_EVENT.shortDateLabel}`,
    description: DESCRIPTION,
    // One-off campaign page: shared by link/ads/QR, never sitemapped or indexed.
    robots: { index: false, follow: true },
    alternates: { canonical: absoluteUrl(MARKET_LOCALE, MARKET_PATH) },
    openGraph: {
      title: 'This Saturday, in El Médano — Anna Ciok',
      description: DESCRIPTION,
      locale: 'en',
      images: [
        {
          url: `${SITE_URL}${hero.src}`,
          width: hero.width,
          height: hero.height,
          alt: 'Fuerte Piba prints and a hand-painted plate by Anna Ciok',
        },
      ],
    },
  };
}

/**
 * Campaign landing page inviting visitors to Anna's stand at the El Médano
 * handicraft market (Sat 10 Oct 2026). English-only: other locales redirect
 * here. Main conversion: "Get directions" (see MARKET_ENGAGEMENT).
 */
export default async function MarketPage({ params }: Props) {
  const locale = requireLocale((await params).locale);
  if (locale !== MARKET_LOCALE) {
    redirect({ href: MARKET_PATH, locale: MARKET_LOCALE });
  }
  setRequestLocale(locale);
  const t = await getTranslations({ locale });

  const mapsUrl = marketMapsUrl();
  const calendarUrl = marketCalendarUrl();

  const showroom: MarketGalleryItem[] = MARKET_SHOWROOM_IDS.flatMap((id) => {
    const product = registryProductById(id);
    if (!product) return [];
    const category = getCategory(product.category);
    const name = productDisplayName(product, t(`product.${category.singularKey}`));
    return [
      {
        id,
        src: product.image,
        ...showroomImageSize(product.category),
        alt: `${name}, ${MARKET_SHOWROOM_ALT[id]}`,
        label: t(category.nameKey),
        title: name,
        specs: [
          { label: 'Size', value: product.measure },
          { label: 'Made in', value: 'Güímar, Tenerife' },
        ],
      },
    ];
  });

  const photos: MarketGalleryItem[] = [...MARKET_LOOKBOOK, MARKET_PLATE_WALL].map((photo) => ({
    id: `photo-${photo.image.key}`,
    src: photo.image.src,
    width: photo.image.width,
    height: photo.image.height,
    alt: photo.alt,
    label: photo.label,
    caption: photo.caption,
  }));

  const galleries: MarketGalleries = { showroom, photos };

  const directionsLink = (placement: string, className: string, children: React.ReactNode) => (
    <a
      className={className}
      href={mapsUrl}
      target="_blank"
      rel="noopener"
      data-market-track={MARKET_ENGAGEMENT.directions}
      data-placement={placement}
    >
      {children}
    </a>
  );

  const actions = (placement: string) => (
    <>
      {directionsLink(
        `${placement}_button`,
        'btn btn-primary',
        <>
          <Icon name="pin" />
          <span>Get directions</span>
        </>,
      )}
      <a
        className="btn btn-ghost"
        href={calendarUrl}
        target="_blank"
        rel="noopener"
        data-market-track={MARKET_ENGAGEMENT.calendar}
        data-placement={placement}
      >
        <Icon name="calendar" />
        <span>Add to calendar</span>
      </a>
    </>
  );

  return (
    <main>
      <MarketGalleryProvider galleries={galleries} showroomNote={SHOWROOM_NOTE}>
        {/* ── HERO ─────────────────────────────────────────────── */}
        <section className="gallery-page-head market-hero">
          <div className="gallery-page-head-inner">
            <div className="gallery-page-copy">
              <div className="eyebrow">Handicraft market · Mercadillo artesanal</div>
              <h1>
                <span className="hero-line1">This Saturday,</span>
                <span className="hero-line2">in El Médano.</span>
              </h1>
              <p className="lead">
                Hand-painted ceramics and fine art prints, straight from my studio in Tenerife. Come find a
                souvenir that’s actually from the island — or the piece your apartment has been missing.
              </p>
              <dl className="market-facts">
                <div className="contact-row">
                  <dt className="lbl">When</dt>
                  <dd className="val">
                    {MARKET_EVENT.shortDateLabel} · {MARKET_EVENT.timeLabel}
                  </dd>
                </div>
                <div className="contact-row">
                  <dt className="lbl">Where</dt>
                  <dd className="val">
                    {directionsLink('hero_address', 'market-text-link', MARKET_EVENT.place)}
                  </dd>
                </div>
                <div className="contact-row">
                  <dt className="lbl">Pay</dt>
                  <dd className="val">{MARKET_EVENT.payment}</dd>
                </div>
              </dl>
              <div className="gallery-page-actions">{actions('hero')}</div>
            </div>

            <figure className="gallery-hero-figure market-hero-figure">
              <div className="market-hero-media">
                <div className="gallery-hero-frame" style={{ aspectRatio: '4 / 5' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={MARKET_IMAGES.printsPlate.src}
                    srcSet={srcSet(MARKET_IMAGES.printsPlate.src)}
                    sizes="(min-width:861px) 46vw, 100vw"
                    alt="Two Fuerte Piba prints, one black and one cream, with a hand-painted plate between them on a sunlit concrete floor"
                    width={MARKET_IMAGES.printsPlate.width}
                    height={MARKET_IMAGES.printsPlate.height}
                    fetchPriority="high"
                  />
                </div>
                <div className="market-date-badge" aria-hidden="true">
                  <span>Saturday</span>
                  <span className="market-date-day">10</span>
                  <span>October</span>
                </div>
              </div>
              <figcaption>
                <span>From the studio</span>
                Fuerte Piba prints and a hand-painted plate.
              </figcaption>
            </figure>
          </div>
        </section>

        <Marquee items={MARQUEE} />

        {/* ── TAKE TENERIFE HOME ───────────────────────────────── */}
        <section className="section market-split reveal">
          <div className="section-inner">
            <div className="story">
              <div className="story-art">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={MARKET_IMAGES.palmVases.src}
                  srcSet={srcSet(MARKET_IMAGES.palmVases.src)}
                  sizes="(min-width:861px) 50vw, 100vw"
                  alt="Anna holding two white vases hand-painted with blue palm trees and terracotta striped rims"
                  loading="lazy"
                />
              </div>
              <div className="story-text">
                <div className="section-eyebrow">Take Tenerife home</div>
                <h2 className="section-title">
                  A souvenir that’s <em>actually from here.</em>
                </h2>
                <p>
                  Skip the fridge magnets. Every plate, mug and vase on my table is painted by hand in my studio in
                  Güímar, with motifs taken from the island — palm trees, the Canarian sun, a siren, women in
                  wide-brimmed hats.
                </p>
                <p>No two are alike, so the piece you choose on Saturday exists only once.</p>
                <div className="market-tip">
                  <h3>Flying home?</h3>
                  <p>Prints travel flat in a suitcase — and ask me how to pack ceramics safely for the trip.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── FOR THE APARTMENT ────────────────────────────────── */}
        <section className="section market-split market-split-reverse market-cream reveal">
          <div className="section-inner">
            <div className="story">
              <div className="story-art">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={MARKET_IMAGES.framedPrints.src}
                  srcSet={srcSet(MARKET_IMAGES.framedPrints.src)}
                  sizes="(min-width:861px) 50vw, 100vw"
                  alt="Framed Agüita and Chacho, Calma prints in blue leaning on a wooden shelf above green tiles, in warm afternoon light"
                  loading="lazy"
                />
              </div>
              <div className="story-text">
                <div className="section-eyebrow">For your place on the island</div>
                <h2 className="section-title">
                  Something for <em>the apartment.</em>
                </h2>
                <p>
                  Just moved here, or giving a holiday flat some soul? Lean a pair of prints on the shelf, set a palm
                  vase by the window, eat off plates nobody else owns — bold, sunny pieces made for Canarian light
                  and white walls.
                </p>
                <p>The prints carry Canarian sayings, and the characters that go with them:</p>
                <ul className="market-pills">
                  <li>Agüita</li>
                  <li>Chacho, calma</li>
                  <li>Fuerte piba</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ── LOOKBOOK ─────────────────────────────────────────── */}
        <section className="section market-lookbook reveal">
          <div className="section-inner">
            <SectionHead
              eyebrow="Lookbook"
              title={
                <>
                  On the table, <em>on the wall.</em>
                </>
              }
              aside={
                <p className="market-head-aside">
                  Pieces made to be used every day — and just as happy hung on a wall next to a print.
                </p>
              }
            />
            <div className="market-lookbook-grid">
              {MARKET_LOOKBOOK.map((photo, i) => (
                <figure key={photo.image.key} className="gallery-hero-figure">
                  <GalleryTrigger
                    gallery="photos"
                    index={i}
                    className="lookbook-frame market-zoom"
                    label={`View larger: ${photo.caption}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.image.src}
                      srcSet={srcSet(photo.image.src)}
                      sizes="(min-width:861px) 23vw, 50vw"
                      alt={photo.alt}
                      width={photo.image.width}
                      height={photo.image.height}
                      loading="lazy"
                      decoding="async"
                      style={{ aspectRatio: `${photo.image.width} / ${photo.image.height}` }}
                    />
                    <span className="market-zoom-icon" aria-hidden="true">
                      <Icon name="expand" />
                    </span>
                  </GalleryTrigger>
                  <figcaption>
                    <span>{photo.label}</span>
                    {photo.caption}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        {/* ── PLATE WALL ───────────────────────────────────────── */}
        <section className="market-wall" aria-label="A wall of hand-painted plates">
          <GalleryTrigger
            gallery="photos"
            index={MARKET_LOOKBOOK.length}
            className="market-wall-trigger"
            label="View the plate wall photo larger"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={MARKET_PLATE_WALL.image.src}
              srcSet={srcSet(MARKET_PLATE_WALL.image.src)}
              sizes="100vw"
              alt={MARKET_PLATE_WALL.alt}
              loading="lazy"
              decoding="async"
            />
          </GalleryTrigger>
          <div className="hero-scrim" />
          <div className="hero-overlay">
            <p className="hero-title">
              <span className="hero-line1">No two alike.</span>
              <span className="hero-line2">Every plate painted by hand.</span>
            </p>
          </div>
        </section>

        {/* ── ON THE TABLE ─────────────────────────────────────── */}
        <section className="section craft market-table reveal" id="table">
          <div className="section-inner">
            <SectionHead
              eyebrow="On the table"
              title={
                <>
                  What you’ll find <em>on Saturday.</em>
                </>
              }
            />
            <div className="craft-grid">
              {[
                ['Plates', 'From side plates to large serving plates.'],
                ['Mugs', 'For a slow café con leche on the terrace.'],
                ['Vases', 'Small, medium and large — palms included.'],
                ['Bowls', 'Large serving bowls and wavy-rimmed ones.'],
                ['Fine art prints', 'Canarian sayings and characters for your walls.'],
              ].map(([title, text], i) => (
                <div key={title} className="craft-item">
                  <div className="num">{String(i + 1).padStart(2, '0')}</div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              ))}
            </div>
            <p className="market-table-note">
              Every ceramic piece is one of a kind. Once it’s sold, it’s gone — <em>come early.</em>
            </p>
          </div>
        </section>

        {/* ── FROM THE SHOWROOM ────────────────────────────────── */}
        <section className="section market-showroom reveal" id="showroom">
          <div className="section-inner">
            <SectionHead
              eyebrow="From the showroom"
              title={
                <>
                  A taste of <em>what I make.</em>
                </>
              }
              aside={
                <p className="market-head-aside">
                  Pieces from earlier collections — not a list of what’s on the stand. Every piece is one of a kind,
                  so come and see what’s on the table on Saturday.
                </p>
              }
            />
            <div className="showroom-grid">
              {showroom.map((piece, i) => (
                <div key={piece.id} className="showroom-card">
                  <GalleryTrigger
                    gallery="showroom"
                    index={i}
                    className="showroom-card-media market-zoom"
                    label={`View ${piece.title} larger`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={piece.src}
                      srcSet={srcSet(piece.src)}
                      sizes="(min-width:1101px) 25vw, 50vw"
                      alt={piece.alt}
                      loading="lazy"
                    />
                    <span className="showroom-tag">Earlier work</span>
                    <span className="market-zoom-icon" aria-hidden="true">
                      <Icon name="expand" />
                    </span>
                  </GalleryTrigger>
                  <div className="showroom-card-body">
                    <div className="eyebrow">{piece.label}</div>
                    <h3>{piece.title}</h3>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── THE ARTIST ───────────────────────────────────────── */}
        <section className="section market-cream reveal" id="studio">
          <div className="section-inner">
            <div className="story">
              <div className="story-art">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={MARKET_IMAGES.annaPlates.src}
                  srcSet={srcSet(MARKET_IMAGES.annaPlates.src)}
                  sizes="(min-width:861px) 50vw, 100vw"
                  alt="Anna Ciok in her studio holding a black cat, smiling over a table covered in hand-painted black and terracotta plates"
                  loading="lazy"
                  style={{ objectPosition: '50% 30%' }}
                />
                <span className="signature">Anna</span>
              </div>
              <div className="story-text">
                <div className="section-eyebrow">Hola, I’m Anna</div>
                <h2 className="section-title">
                  One pair of hands, <em>one piece at a time.</em>
                </h2>
                <p>
                  I live and work in Tenerife. In my small studio in Güímar I paint watercolours on paper and
                  hand-paint ceramic tableware — never mass-produced. The island’s colours, sayings and characters end
                  up on almost everything I make.
                </p>
                <p>Stop by the stand to say hola, pick up a plate, and ask me anything about how it was made.</p>
                <div className="story-actions">
                  <a
                    className="btn btn-ghost"
                    href="https://www.instagram.com/anna.ciok.art/"
                    target="_blank"
                    rel="noopener"
                    data-market-track={MARKET_ENGAGEMENT.outbound}
                    data-placement="artist"
                    data-method="instagram"
                  >
                    <span>Follow on Instagram</span>
                    <Icon name="arrow" className="btn-arrow" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── VISIT ────────────────────────────────────────────── */}
        <section className="section contact" id="visit">
          <div className="contact-inner">
            <div>
              <h2 className="market-contact-title">
                ¡Nos vemos <em>en la plaza!</em>
              </h2>
              <p>See you at the plaza on Saturday. Come early for the best pick — every ceramic piece is one of a kind.</p>
              <div className="gallery-page-actions">{actions('visit')}</div>
            </div>
            <dl className="contact-list">
              <div className="contact-row">
                <dt className="lbl">When</dt>
                <dd className="val">
                  {MARKET_EVENT.dateLabel} · {MARKET_EVENT.timeLabel}
                </dd>
              </div>
              <div className="contact-row">
                <dt className="lbl">Where</dt>
                <dd className="val">
                  {directionsLink('visit_address', 'market-text-link', MARKET_EVENT.place)} · {MARKET_EVENT.area}
                </dd>
              </div>
              <div className="contact-row">
                <dt className="lbl">Pay</dt>
                <dd className="val">{MARKET_EVENT.payment}</dd>
              </div>
              <div className="contact-row">
                <dt className="lbl">Can’t make it?</dt>
                <dd className="val">
                  <Link
                    href="/sklep"
                    className="market-text-link"
                    data-market-track={MARKET_ENGAGEMENT.outbound}
                    data-placement="visit"
                    data-method="shop"
                  >
                    Shop online
                  </Link>
                  , or visit my studio in Güímar by appointment.
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </MarketGalleryProvider>
    </main>
  );
}
