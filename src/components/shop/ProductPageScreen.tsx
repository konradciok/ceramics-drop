import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { getCurrency } from '@/lib/currency.server';
import { CATEGORIES, getProductsByCategory } from '@/lib/products';
import { SITE_NAME } from '@/lib/site';
import { SelectionBar } from './SelectionBar';
import { AddToCartButton } from './AddToCartButton';
import { ShowroomInterestForm } from './ShowroomInterestForm';
import { PdpDelivery } from './PdpDelivery';
import { ProductPageGallery } from './ProductPageGallery';
import { ProductTileLink } from './ProductTileLink';
import { ProductViewAnalytics } from './ProductViewAnalytics';
import type { Product } from '@/lib/types';

type Props = { product: Product; soldIds: readonly string[]; showroomIds?: readonly string[]; noteOverride?: string };

/** Full product detail page layout — server component with client islands. */
export async function ProductPageScreen({ product, soldIds, showroomIds = [], noteOverride }: Props) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const currency = await getCurrency(locale);
  const { fmt } = currencyFormatter(currency);

  const cat = CATEGORIES[product.category];
  const name = t(`product.${cat.singularKey}`);
  const categoryName = t(cat.nameKey);
  const displayName = `${name} Nº ${product.num}`;
  const rawNotes = t.raw(`notes.${product.category}`) as unknown;
  const fallbackNote = Array.isArray(rawNotes) ? ((rawNotes[product.noteIndex] as string) ?? '') : '';
  const note = noteOverride ?? fallbackNote;

  const images = [product.image, ...(product.gallery ?? [])];
  const soldSet = new Set(soldIds);
  const showroomSet = new Set(showroomIds);
  const soldLabel = t('gallery.sold');
  const showroomLabel = t('gallery.showroom');
  const showroom = product.showroom === true;

  // Up to 4 sibling pieces from the same category with live sold + showroom overlay
  const siblings = getProductsByCategory(product.category)
    .filter((p) => p.id !== product.id)
    .map((p) => {
      const merged = soldSet.has(p.id) ? { ...p, sold: true } : p;
      return showroomSet.has(p.id) ? { ...merged, showroom: true } : merged;
    })
    .slice(0, 4);

  return (
    <>
      {/* Showroom pieces aren't purchasable — don't fire ecommerce view_item
          (it would pollute demand funnels); the showroom_product_view engagement
          event on tiles / the /showroom page covers this surface instead. */}
      {!showroom && <ProductViewAnalytics product={product} />}
      <article className="pdp">
        <div className="pdp-inner">
          <nav className="pdp-breadcrumb" aria-label="breadcrumb">
            <Link href="/">{SITE_NAME}</Link>
            <span className="pdp-breadcrumb-sep" aria-hidden="true">/</span>
            <Link href={`/${product.category}`}>{categoryName}</Link>
            <span className="pdp-breadcrumb-sep" aria-hidden="true">/</span>
            <span aria-current="page">{displayName}</span>
          </nav>

          <div className="pdp-layout">
            <ProductPageGallery images={images} alt={displayName} />

            <div className="pdp-body">
              <div className="eyebrow">
                {categoryName} — {t('lightbox.drop')}
              </div>
              <h1>
                {name} <em>Nº {product.num}</em>
              </h1>
              <div className="pdp-price">{fmt(priceOfCurrency(product, currency))}</div>
              {!product.sold && !showroom && <PdpDelivery product={product} currency={currency} />}
              {note && <p className="pdp-note">{note}</p>}
              <div className="lb-specs">
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specDims')}</span>
                  <span className="v">{`${t('lightbox.approx')} ${product.measure}`}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specTech')}</span>
                  <span className="v">{t('lightbox.specTechVal')}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specCopy')}</span>
                  <span className="v">{t('lightbox.specCopyVal')}</span>
                </div>
              </div>
              {showroom ? (
                <div className="pdp-showroom" data-testid="pdp-showroom">
                  <p className="pdp-showroom-copy">{t('showroom.pdpCopy')}</p>
                  <ShowroomInterestForm productId={product.id} />
                </div>
              ) : (
                <AddToCartButton product={product} />
              )}
            </div>
          </div>
        </div>

        {siblings.length > 0 && (
          <section className="pdp-more">
            <div className="pdp-more-inner">
              <h2>
                {t('product.moreFrom')} — {categoryName}
              </h2>
              <div className="gallery" data-count={siblings.length}>
                {siblings.map((p) => (
                  <ProductTileLink
                    key={p.id}
                    product={p}
                    displayName={`${t(`product.${CATEGORIES[p.category].singularKey}`)} Nº ${p.num}`}
                    soldLabel={soldLabel}
                    showroomLabel={showroomLabel}
                    priceLabel={fmt(priceOfCurrency(p, currency))}
                  />
                ))}
              </div>
              <div className="pdp-more-cta">
                <Link href={`/${product.category}`} className="btn btn-ghost">
                  {t('product.seeAll')} — {categoryName}
                </Link>
              </div>
            </div>
          </section>
        )}
      </article>
      <SelectionBar />
    </>
  );
}
