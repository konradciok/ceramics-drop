import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { srcSet } from '@/lib/images';
import { siteMediaUrl } from '@/lib/site-media';
import type { EditorialImage } from '@/lib/editorial-images';
import type { HeroMediaSlot, HomePagePayload } from '@/lib/cms/types';
import { HeroVideo, type HeroVideoSlot } from './HeroVideo';

type ResolvedHeroMedia = {
  imgSrc: string;
  srcSet?: string;
  width: number;
  height: number;
  video?: HeroVideoSlot;
};

/**
 * A CMS slot resolves to a single `siteMediaUrl(key)` (no responsive
 * srcset — the admin controls the source dimensions directly). A null slot
 * falls back to a committed static default image, using the site's existing
 * `srcSet()` helper for responsive variants. A video slot always resolves its
 * *poster* as the picture element's image — the LCP element is always a
 * server-rendered `<img>`, never the client-mounted `<video>`.
 */
function resolveSlot(slot: HeroMediaSlot, fallback: EditorialImage): ResolvedHeroMedia {
  if (slot == null) {
    return {
      imgSrc: fallback.src,
      srcSet: srcSet(fallback.src),
      width: fallback.width,
      height: fallback.height,
    };
  }
  if (slot.kind === 'image') {
    return { imgSrc: siteMediaUrl(slot.key), width: slot.width, height: slot.height };
  }
  return {
    imgSrc: siteMediaUrl(slot.poster.key),
    width: slot.poster.width,
    height: slot.poster.height,
    video: {
      src: siteMediaUrl(slot.key),
      poster: {
        src: siteMediaUrl(slot.poster.key),
        width: slot.poster.width,
        height: slot.poster.height,
      },
    },
  };
}

type Props = {
  content: HomePagePayload;
  /** Committed static default used for either slot when the CMS has no media
      published (or during preview of an unset slot). */
  fallbackImage: EditorialImage;
};

/** Full-bleed CMS-managed homepage hero: a single `<picture>` (desktop/mobile
    sources) carries the LCP image, an optional client-mounted `<video>`
    overlays it per breakpoint, and a bottom-left overlay carries the copy +
    single CTA over a gradient scrim. */
export function HomeHero({ content, fallbackImage }: Props) {
  const desktop = resolveSlot(content.media.desktop, fallbackImage);
  const mobile = resolveSlot(content.media.mobile, fallbackImage);

  return (
    <section className="hero">
      <picture className="hero-media">
        <source media="(min-width:861px)" srcSet={desktop.srcSet ?? desktop.imgSrc} sizes="100vw" />
        <img
          src={mobile.imgSrc}
          srcSet={mobile.srcSet}
          sizes="100vw"
          alt={content.heroAlt ?? ''}
          width={mobile.width}
          height={mobile.height}
          fetchPriority="high"
        />
      </picture>
      {(desktop.video || mobile.video) && <HeroVideo desktop={desktop.video} mobile={mobile.video} />}
      <div className="hero-scrim" aria-hidden="true" />
      <div className="hero-overlay">
        <h1 className="hero-title">
          <span className="hero-line1">{content.heroLine1}</span>{' '}
          <span className="hero-line2">{content.heroLine2}</span>
        </h1>
        {content.heroTagline && <p className="hero-tagline">{content.heroTagline}</p>}
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/sklep">
            <span>{content.ctaLabel}</span>
            <Icon name="arrow" className="btn-arrow" />
          </Link>
        </div>
      </div>
    </section>
  );
}
