import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { getCurrency } from '@/lib/currency.server';
import { CATEGORIES, getProductsByCategory } from '@/lib/products';
import { SITE_NAME } from '@/lib/site';
import { SelectionBar } from './SelectionBar';
import { AddToCartButton } from './AddToCartButton';
import { ProductPageGallery } from './ProductPageGallery';
import { ProductTileLink } from './ProductTileLink';
import { ProductViewAnalytics } from './ProductViewAnalytics';
import type { Product } from '@/lib/types';

type Props = { product: Product; soldIds: readonly string[] };

/** Full product detail page layout — server component with client islands. */
export async function ProductPageScreen({ product, soldIds }: Props) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const currency = await getCurrency(locale);
  const { fmt } = currencyFormatter(currency);

  const cat = CATEGORIES[product.category];
  const name = t(`product.${cat.singularKey}`);
  const categoryName = t(cat.nameKey);
  const displayName = `${name} Nº ${product.num}`;
  const rawNotes = t.raw(`notes.${product.category}`) as unknown;
  const note = Array.isArray(rawNotes) ? ((rawNotes[product.noteIndex] as string) ?? '') : '';

  const images = [product.image, ...(product.gallery ?? [])];
  const soldSet = new Set(soldIds);
  const soldLabel = t('gallery.sold');

  // Up to 4 sibling pieces from the same category with live sold overlay applied
  const siblings = getProductsByCategory(product.category)
    .filter((p) => p.id !== product.id)
    .map((p) => (soldSet.has(p.id) ? { ...p, sold: true } : p))
    .slice(0, 4);

  return (
    <>
      <ProductViewAnalytics product={product} />
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
              <AddToCartButton product={product} />
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
