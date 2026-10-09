import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
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
import { getMarketTranslator, isMarketExtraLang, type MarketLang } from '@/lib/market-copy';
import {
  MARKET_DIRECTIONS_EVENT,
  MARKET_ENGAGEMENT,
  MARKET_IMAGES,
  MARKET_LOOKBOOK,
  MARKET_PLATE_WALL,
  MARKET_SHOWROOM_IDS,
  marketCalendarUrl,
  marketMapsUrl,
  showroomImageSize,
} from '@/lib/market-event';
import { productDisplayName, registryProductById } from '@/lib/products';

const em = (chunks: ReactNode) => <em>{chunks}</em>;

/** Canarian sayings printed on the fine art prints: kept in the original on every language. */
const PRINT_SAYINGS = ['Agüita', 'Chacho, calma', 'Fuerte piba'];

/**
 * Campaign landing page inviting visitors to Anna's stand at the El Médano
 * handicraft market (Sat 10 Oct 2026). Rendered for the four site locales
 * (`/el-medano`, `/en/…`, `/es/…`, `/de/…`) and, in the `en` shell, for the
 * page-only languages at `/en/el-medano/<lang>`. Main conversion: "Get
 * directions" (see MARKET_ENGAGEMENT).
 */
export async function MarketPage({ lang }: { lang: MarketLang }) {
  const t = await getMarketTranslator(lang);

  const mapsUrl = marketMapsUrl();
  const calendarUrl = marketCalendarUrl({
    name: t('event.name'),
    place: t('event.place'),
    calendarDetails: t('event.calendarDetails'),
    mapLabel: t('event.mapLabel'),
  });

  const showroomNote = t('showroom.note');

  const showroom: MarketGalleryItem[] = MARKET_SHOWROOM_IDS.flatMap((id) => {
    const product = registryProductById(id);
    if (!product) return [];
    const category = t(`categories.${product.category}.name`);
    const name = productDisplayName(product, t(`categories.${product.category}.singular`));
    return [
      {
        id,
        src: product.image,
        ...showroomImageSize(product.category),
        alt: t('showroom.pieceAlt', { name, detail: t(`showroom.alt.${id}`) }),
        label: category,
        title: name,
        specs: [
          { label: t('showroom.size'), value: product.measure },
          { label: t('showroom.madeIn'), value: t('showroom.madeInValue') },
        ],
      },
    ];
  });

  const photoCopy = (key: string) => ({
    label: t(`photos.${key}.label`),
    caption: t(`photos.${key}.caption`),
    alt: t(`photos.${key}.alt`),
  });
  const lookbook = MARKET_LOOKBOOK.map((photo) => ({ ...photo, ...photoCopy(photo.image.key) }));
  const plateWall = { ...MARKET_PLATE_WALL, ...photoCopy(MARKET_PLATE_WALL.image.key) };

  const photos: MarketGalleryItem[] = [...lookbook, plateWall].map((photo) => ({
    id: `photo-${photo.image.key}`,
    src: photo.image.src,
    width: photo.image.width,
    height: photo.image.height,
    alt: photo.alt,
    label: photo.label,
    caption: photo.caption,
  }));

  const galleries: MarketGalleries = { showroom, photos };

  const directionsLink = (placement: string, className: string, children: ReactNode) => (
    <a
      className={className}
      href={mapsUrl}
      target="_blank"
      rel="noopener"
      data-market-track={MARKET_DIRECTIONS_EVENT}
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
          <span>{t('hero.directions')}</span>
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
        <span>{t('hero.calendar')}</span>
      </a>
    </>
  );

  const tableItems = [0, 1, 2, 3, 4].map((i) => ({
    title: t(`table.items.${i}.title`),
    text: t(`table.items.${i}.text`),
  }));
  const marquee = [0, 1, 2, 3, 4].map((i) => t(`marquee.${i}`));

  return (
    // Page-only languages render inside the `en` shell, so mark the body's own language.
    <main lang={isMarketExtraLang(lang) ? lang : undefined}>
      <MarketGalleryProvider
        galleries={galleries}
        showroomNote={showroomNote}
        labels={{ close: t('aria.close'), prev: t('aria.prev'), next: t('aria.next'), photo: t('aria.photo') }}
      >
        {/* ── HERO ─────────────────────────────────────────────── */}
        <section className="gallery-page-head market-hero">
          <div className="gallery-page-head-inner">
            <div className="gallery-page-copy">
              <div className="eyebrow">{t('hero.eyebrow')}</div>
              <h1>
                <span className="hero-line1">{t('hero.line1')}</span>
                <span className="hero-line2">{t('hero.line2')}</span>
              </h1>
              <p className="lead">{t('hero.lead')}</p>
              <dl className="market-facts">
                <div className="contact-row">
                  <dt className="lbl">{t('hero.when')}</dt>
                  <dd className="val">
                    {t('event.shortDateLabel')} · {t('event.timeLabel')}
                  </dd>
                </div>
                <div className="contact-row">
                  <dt className="lbl">{t('hero.where')}</dt>
                  <dd className="val">{directionsLink('hero_address', 'market-text-link', t('event.place'))}</dd>
                </div>
                <div className="contact-row">
                  <dt className="lbl">{t('hero.pay')}</dt>
                  <dd className="val">{t('event.payment')}</dd>
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
                    alt={t('hero.imageAlt')}
                    width={MARKET_IMAGES.printsPlate.width}
                    height={MARKET_IMAGES.printsPlate.height}
                    fetchPriority="high"
                  />
                </div>
                <div className="market-date-badge" aria-hidden="true">
                  <span>{t('hero.badgeDay')}</span>
                  <span className="market-date-day">{t('hero.badgeNumber')}</span>
                  <span>{t('hero.badgeMonth')}</span>
                </div>
              </div>
              <figcaption>
                <span>{t('hero.captionLabel')}</span>
                {t('hero.caption')}
              </figcaption>
            </figure>
          </div>
        </section>

        <Marquee items={marquee} />

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
                  alt={t('take.imageAlt')}
                  loading="lazy"
                />
              </div>
              <div className="story-text">
                <div className="section-eyebrow">{t('take.eyebrow')}</div>
                <h2 className="section-title">{t.rich('take.title', { em })}</h2>
                <p>{t('take.p1')}</p>
                <p>{t('take.p2')}</p>
                <div className="market-tip">
                  <h3>{t('take.tipTitle')}</h3>
                  <p>{t('take.tipText')}</p>
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
                  alt={t('apartment.imageAlt')}
                  loading="lazy"
                />
              </div>
              <div className="story-text">
                <div className="section-eyebrow">{t('apartment.eyebrow')}</div>
                <h2 className="section-title">{t.rich('apartment.title', { em })}</h2>
                <p>{t('apartment.p1')}</p>
                <p>{t('apartment.p2')}</p>
                <ul className="market-pills">
                  {PRINT_SAYINGS.map((saying) => (
                    <li key={saying}>{saying}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ── LOOKBOOK ─────────────────────────────────────────── */}
        <section className="section market-lookbook reveal">
          <div className="section-inner">
            <SectionHead
              eyebrow={t('lookbook.eyebrow')}
              title={t.rich('lookbook.title', { em })}
              aside={<p className="market-head-aside">{t('lookbook.aside')}</p>}
            />
            <div className="market-lookbook-grid">
              {lookbook.map((photo, i) => (
                <figure key={photo.image.key} className="gallery-hero-figure">
                  <GalleryTrigger
                    gallery="photos"
                    index={i}
                    className="lookbook-frame market-zoom"
                    label={t('lookbook.viewLarger', { caption: photo.caption })}
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
        <section className="market-wall" aria-label={t('wall.ariaLabel')}>
          <GalleryTrigger
            gallery="photos"
            index={lookbook.length}
            className="market-wall-trigger"
            label={t('wall.view')}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={plateWall.image.src}
              srcSet={srcSet(plateWall.image.src)}
              sizes="100vw"
              alt={plateWall.alt}
              loading="lazy"
              decoding="async"
            />
          </GalleryTrigger>
          <div className="hero-scrim" />
          <div className="hero-overlay">
            <p className="hero-title">
              <span className="hero-line1">{t('wall.line1')}</span>
              <span className="hero-line2">{t('wall.line2')}</span>
            </p>
          </div>
        </section>

        {/* ── ON THE TABLE ─────────────────────────────────────── */}
        <section className="section craft market-table reveal" id="table">
          <div className="section-inner">
            <SectionHead eyebrow={t('table.eyebrow')} title={t.rich('table.title', { em })} />
            <div className="craft-grid">
              {tableItems.map(({ title, text }, i) => (
                <div key={i} className="craft-item">
                  <div className="num">{String(i + 1).padStart(2, '0')}</div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              ))}
            </div>
            <p className="market-table-note">{t.rich('table.note', { em })}</p>
          </div>
        </section>

        {/* ── FROM THE SHOWROOM ────────────────────────────────── */}
        <section className="section market-showroom reveal" id="showroom">
          <div className="section-inner">
            <SectionHead
              eyebrow={t('showroom.eyebrow')}
              title={t.rich('showroom.title', { em })}
              aside={<p className="market-head-aside">{t('showroom.aside')}</p>}
            />
            <div className="showroom-grid">
              {showroom.map((piece, i) => (
                <div key={piece.id} className="showroom-card">
                  <GalleryTrigger
                    gallery="showroom"
                    index={i}
                    className="showroom-card-media market-zoom"
                    label={t('showroom.viewPiece', { title: piece.title ?? piece.label })}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={piece.src}
                      srcSet={srcSet(piece.src)}
                      sizes="(min-width:1101px) 25vw, 50vw"
                      alt={piece.alt}
                      loading="lazy"
                    />
                    <span className="showroom-tag">{t('showroom.tag')}</span>
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
                  alt={t('artist.imageAlt')}
                  loading="lazy"
                  style={{ objectPosition: '50% 30%' }}
                />
                <span className="signature">{t('artist.signature')}</span>
              </div>
              <div className="story-text">
                <div className="section-eyebrow">{t('artist.eyebrow')}</div>
                <h2 className="section-title">{t.rich('artist.title', { em })}</h2>
                <p>{t('artist.p1')}</p>
                <p>{t('artist.p2')}</p>
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
                    <span>{t('artist.instagram')}</span>
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
              <h2 className="market-contact-title">{t.rich('visit.title', { em })}</h2>
              <p>{t('visit.text')}</p>
              <div className="gallery-page-actions">{actions('visit')}</div>
            </div>
            <dl className="contact-list">
              <div className="contact-row">
                <dt className="lbl">{t('visit.when')}</dt>
                <dd className="val">
                  {t('event.dateLabel')} · {t('event.timeLabel')}
                </dd>
              </div>
              <div className="contact-row">
                <dt className="lbl">{t('visit.where')}</dt>
                <dd className="val">
                  {directionsLink('visit_address', 'market-text-link', t('event.place'))} · {t('event.area')}
                </dd>
              </div>
              <div className="contact-row">
                <dt className="lbl">{t('visit.pay')}</dt>
                <dd className="val">{t('event.payment')}</dd>
              </div>
              <div className="contact-row">
                <dt className="lbl">{t('visit.cantMakeIt')}</dt>
                <dd className="val">
                  <Link
                    href="/sklep"
                    className="market-text-link"
                    data-market-track={MARKET_ENGAGEMENT.outbound}
                    data-placement="visit"
                    data-method="shop"
                  >
                    {t('visit.shop')}
                  </Link>
                  {t('visit.studio')}
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </MarketGalleryProvider>
    </main>
  );
}
