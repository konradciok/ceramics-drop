import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { srcSet } from '@/lib/images';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';
import { SITE_URL } from '@/lib/site';
import { GALLERY_EDITORIAL_IMAGES } from '@/lib/editorial-images';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  const hero = GALLERY_EDITORIAL_IMAGES[0];
  return {
    title: t('title.gallery'),
    description: t('meta.gallery'),
    alternates: alternatesFor(locale as Locale, '/gallery'),
    openGraph: {
      images: [
        {
          url: `${SITE_URL}${hero.src}`,
          width: hero.width,
          height: hero.height,
          alt: t(`galleryPage.items.${hero.key}.alt`),
        },
      ],
    },
  };
}

/** Editorial lookbook for studio and moodboard photography. */
export default async function GalleryPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });
  const [hero, ...lookbook] = GALLERY_EDITORIAL_IMAGES;

  return (
    <main>
      <section className="gallery-page-head">
        <div className="gallery-page-head-inner">
          <div className="gallery-page-copy">
            <div className="eyebrow">{t('galleryPage.eyebrow')}</div>
            <h1>{t.rich('galleryPage.title', richTags)}</h1>
            <p className="lead">{t('galleryPage.lead')}</p>
            <div className="gallery-page-actions">
              <Link className="btn btn-primary" href="/sklep">
                <span>{t('galleryPage.ctaShop')}</span>
                <Icon name="arrow" className="btn-arrow" />
              </Link>
              <Link className="btn btn-ghost" href="/o-studiu">
                {t('galleryPage.ctaStudio')}
              </Link>
            </div>
          </div>

          <figure className="gallery-hero-figure">
            <div
              className="gallery-hero-frame"
              style={{ aspectRatio: `${hero.width} / ${hero.height}` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={hero.src}
                srcSet={srcSet(hero.src)}
                sizes="(min-width:861px) 46vw, 100vw"
                alt={t(`galleryPage.items.${hero.key}.alt`)}
                width={hero.width}
                height={hero.height}
                fetchPriority="high"
              />
            </div>
            <figcaption>
              <span>{t(`galleryPage.items.${hero.key}.title`)}</span>
              {t(`galleryPage.items.${hero.key}.caption`)}
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="lookbook" aria-label={t('galleryPage.sequenceLabel')}>
        <div className="lookbook-inner">
          <div className="lookbook-stack">
            {lookbook.map((item) => (
              <article key={item.key} className={`lookbook-item lookbook-item-${item.key}`}>
                <figure>
                  <div
                    className="lookbook-frame"
                    style={{ aspectRatio: `${item.width} / ${item.height}` }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.src}
                      srcSet={srcSet(item.src)}
                      sizes="(min-width:861px) 42vw, 100vw"
                      alt={t(`galleryPage.items.${item.key}.alt`)}
                      width={item.width}
                      height={item.height}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <figcaption>
                    <span>{t(`galleryPage.items.${item.key}.title`)}</span>
                    {t(`galleryPage.items.${item.key}.caption`)}
                  </figcaption>
                </figure>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
