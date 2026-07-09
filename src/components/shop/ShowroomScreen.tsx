/* ============================================================
   ShowroomScreen — dedicated gallery of retired (showroom) pieces.
   Each card shows the piece, its drop label, price for context, a
   "request a similar piece" form, and a link to the normal PDP.
   Server component; the interest form + view analytics are client islands.
   ============================================================ */
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES } from '@/lib/products';
import { getCurrency } from '@/lib/currency.server';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { srcSet } from '@/lib/images';
import { richTags } from '@/components/ui/richTags';
import type { ShowroomEntry } from '@/lib/inventory';
import { ShowroomInterestForm } from './ShowroomInterestForm';
import { ShowroomViewAnalytics } from './ShowroomViewAnalytics';

export async function ShowroomScreen({ entries }: { entries: ShowroomEntry[] }) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const currency = await getCurrency(locale);
  const { fmt } = currencyFormatter(currency);

  return (
    <>
      <ShowroomViewAnalytics count={entries.length} />
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('showroom.eyebrow')}</div>
            <h1>{t.rich('showroom.title', richTags)}</h1>
            <p className="lead">{t('showroom.lead')}</p>
          </div>
        </div>
      </section>

      {entries.length === 0 ? (
        <p className="shop-empty">{t('showroom.empty')}</p>
      ) : (
        <div className="showroom-grid">
          {entries.map(({ product, dropLabel }) => {
            const cat = CATEGORIES[product.category];
            const name = t(`product.${cat.singularKey}`);
            const displayName = `${name} Nº ${product.num}`;
            return (
              <div className="showroom-card" data-testid="showroom-card" data-product-id={product.id} key={product.id}>
                <Link href={`/${product.category}/${product.id}`} className="showroom-card-media" aria-label={displayName}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={product.image}
                    srcSet={srcSet(product.image)}
                    sizes="(min-width:1101px) 33vw, (min-width:561px) 50vw, 100vw"
                    alt={displayName}
                    loading="lazy"
                  />
                  <span className="showroom-tag">{t('gallery.showroom')}</span>
                </Link>
                <div className="showroom-card-body">
                  <div className="eyebrow">{dropLabel ?? t(cat.nameKey)}</div>
                  <h3>
                    <Link href={`/${product.category}/${product.id}`}>{displayName}</Link>
                  </h3>
                  <div className="showroom-card-price">
                    {fmt(priceOfCurrency(product, currency))}
                    {product.sold && <span className="showroom-card-sold"> · {t('gallery.sold')}</span>}
                  </div>
                  <ShowroomInterestForm productId={product.id} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
