import { getTranslations } from 'next-intl/server';
import { getProductById } from '@/lib/products';
import { pln } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { Look } from '@/lib/looks';
import './LookBlock.css';

type Props = {
  look: Look;
  index: number;
  locale: Locale;
  /** Product ids currently sold (from getSoldIds), merged at render time. */
  soldIds: Set<string>;
};

export async function LookBlock({ look, index, locale, soldIds }: Props) {
  const t = await getTranslations();
  const isReverse = index % 2 !== 0;
  const legendId = `look-legend-${look.id}`;

  return (
    <section className={`look-block${isReverse ? ' look-block--reverse' : ''}`}>
      <div className="look-block__grid">

        {/* Text column — DOM-first so mobile stacks text above photo */}
        <div className="look-block__text">
          <div className="look-block__eyebrow">
            {t('inspiracje.lookLabel')} &middot; {String(index + 1).padStart(2, '0')}
          </div>
          <h2 className="look-block__title">{look.title[locale]}</h2>
          <p className="look-block__editorial">{look.editorial[locale]}</p>
          <a className="look-block__cta" href={`#${legendId}`}>
            {t('inspiracje.shopThisLook')} →
          </a>
        </div>

        {/* Photo column — swapped visually on desktop via CSS `order` */}
        <div className="look-block__photo-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="look-block__photo"
            src={look.image}
            alt={look.imageAlt[locale]}
            width={1200}
            height={900}
          />
          {look.markers.map((marker) => {
            const sold = soldIds.has(marker.productId);
            return (
              <div
                key={marker.num}
                className={`look-block__marker${sold ? ' look-block__marker--sold' : ''}`}
                style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
                aria-hidden="true"
              >
                {marker.num}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend — resolves productId → price, reflects sold state, deep-links the piece */}
      <div id={legendId} className="look-block__legend">
        {look.markers.map((marker) => {
          const product = getProductById(marker.productId);
          if (!product) return null;
          const sold = soldIds.has(marker.productId);
          const name = marker.label[locale];

          if (sold) {
            return (
              <span
                key={marker.num}
                className="look-block__legend-item look-block__legend-item--sold"
              >
                <span className="look-block__legend-num">{marker.num}</span>
                <span className="look-block__legend-name">{name}</span>
                <span className="look-block__legend-sold">{t('gallery.sold')}</span>
              </span>
            );
          }

          return (
            <Link
              key={marker.num}
              className="look-block__legend-item"
              href={`/${product.category}#piece-${product.id}`}
            >
              <span className="look-block__legend-num">{marker.num}</span>
              <span className="look-block__legend-name">{name}</span>
              <span className="look-block__legend-price">{pln(product.price)}</span>
              <span className="look-block__legend-arrow" aria-hidden="true">→</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
