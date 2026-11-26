import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { getCurrency } from '@/lib/currency.server';
import { CATEGORIES, getProductsByCategory, isProductPurchasable, productDisplayName } from '@/lib/products';
import { SITE_NAME } from '@/lib/site';
import { dropName } from '@/lib/drop-visibility';
import { SelectionBar } from './SelectionBar';
import { AddToCartButton } from './AddToCartButton';
import { PdpStickyBuy } from './PdpStickyBuy';
import { PdpDelivery } from './PdpDelivery';
import { PurchaseAssurance } from './PurchaseAssurance';
import { ProductPageGallery } from './ProductPageGallery';
import { ProductTileLink } from './ProductTileLink';
import { ProductViewAnalytics } from './ProductViewAnalytics';
import { FooterNewsletterForm } from '@/components/layout/FooterNewsletterForm';
import { pickPdpSiblings } from '@/lib/pdp-siblings';
import type { Product } from '@/lib/types';
import type { ShippingRatesBundle } from '@/lib/shipping-rates/last-known-good';

/** The inline add-to-cart button; the mobile sticky buy bar watches it. */
const INLINE_ADD_ID = 'pdp-add';

/**
 * Whether the PDP gets the mobile sticky buy bar: only a piece that can be
 * bought online right now. Sold, showroom and offline pieces keep the plain
 * selection bar and show no buy control.
 */
export function hasStickyBuy(product: Product): boolean {
  return isProductPurchasable(product);
}

/**
 * Whether the PDP offers the drop-list signup: every sold piece. A sold PDP
 * ends in a disabled button, so it is where the next drop's demand is lost
 * (T9) — whether or not the family still has pieces to buy.
 */
export function hasDropListSignup(product: Product): boolean {
  return product.sold === true;
}

/** Anchor of the sold PDP's signup section (the in-body link jumps to it). */
const DROP_LIST_ID = 'drop-list';

type Props = {
  product: Product;
  soldIds: readonly string[];
  showroomIds?: readonly string[];
  noteOverride?: string;
  /** The CMS-published shipping table checkout charges from (getShippingRatesForDisplay). */
  shipping: ShippingRatesBundle;
};

/** Full product detail page layout — server component with client islands. */
export async function ProductPageScreen({ product, soldIds, showroomIds = [], noteOverride, shipping }: Props) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const currency = await getCurrency(locale);
  const { fmt } = currencyFormatter(currency);

  const cat = CATEGORIES[product.category];
  const name = t(`product.${cat.singularKey}`);
  const categoryName = t(cat.nameKey);
  const dropLabel = dropName(t, product.dropId);
  const displayName = productDisplayName(product, name);
  const rawNotes = t.raw(`notes.${product.category}`) as unknown;
  const fallbackNote = Array.isArray(rawNotes) ? ((rawNotes[product.noteIndex] as string) ?? '') : '';
  const note = noteOverride ?? fallbackNote;

  const images = [product.image, ...(product.gallery ?? [])];
  const soldSet = new Set(soldIds);
  const showroomSet = new Set(showroomIds);
  const soldLabel = t('gallery.sold');
  const showroomLabel = t('gallery.showroom');
  const showroom = product.showroom === true;
  const priceLabel = fmt(priceOfCurrency(product, currency));

  // Sibling pieces from the same category with live sold + showroom overlay;
  // pickPdpSiblings puts purchasable ones first (only those on a sold PDP).
  const siblings = pickPdpSiblings(
    product,
    (await getProductsByCategory(product.category)).map((p) => {
      const merged = soldSet.has(p.id) ? { ...p, sold: true } : p;
      return showroomSet.has(p.id) ? { ...merged, showroom: true } : merged;
    }),
  );
  const dropList = hasDropListSignup(product);

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
                {categoryName}
                {dropLabel && ` — ${dropLabel}`}
              </div>
              <h1>
                {product.title ? product.title : <>{name} <em>Nº {product.num}</em></>}
              </h1>
              <div className="pdp-price">{priceLabel}</div>
              {product.onlineAvailable === true && !product.sold && !showroom && <PdpDelivery product={product} currency={currency} locale={locale} shipping={shipping} />}
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
              {product.onlineAvailable !== true && !product.sold ? (
                <div className="pdp-showroom" data-testid="pdp-showroom">
                  <p className="pdp-showroom-copy">{t('showroom.pdpCopy')}</p>
                  <a className="btn btn-primary" href="mailto:ania@ciok.art">{t('ceramics.visitCta')}</a>
                </div>
              ) : (
                <>
                  <AddToCartButton product={product} id={INLINE_ADD_ID} />
                  {isProductPurchasable(product) && <PurchaseAssurance />}
                </>
              )}
              {dropList && (
                <a className="pdp-drop-list-link" href={`#${DROP_LIST_ID}`} data-testid="pdp-drop-list-link">
                  {t('newsletter.nextDropCta')} <span aria-hidden="true">↓</span>
                </a>
              )}
            </div>
          </div>
        </div>

        {siblings.length > 0 && (
          <section className="pdp-more" data-testid="pdp-more">
            <div className="pdp-more-inner">
              <h2>
                {t('product.moreFrom')} — {categoryName}
              </h2>
              <div className="gallery" data-count={siblings.length}>
                {siblings.map((p) => (
                  <ProductTileLink
                    key={p.id}
                    product={p}
                    displayName={productDisplayName(p, t(`product.${CATEGORIES[p.category].singularKey}`))}
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

        {/* Purchasable siblings (above) come first — an immediate alternative —
            then the signup for the next drop. */}
        {dropList && (
          <section className="pdp-more pdp-more--newsletter" id={DROP_LIST_ID} data-testid="pdp-drop-list">
            <div className="pdp-more-inner">
              <h2>{t('newsletter.nextDropHeading')}</h2>
              <FooterNewsletterForm placement="sold_pdp" />
              {siblings.length === 0 && (
                <div className="pdp-more-cta">
                  <Link href={`/${product.category}`} className="btn btn-ghost">
                    {t('product.seeAll')} — {categoryName}
                  </Link>
                </div>
              )}
            </div>
          </section>
        )}
      </article>
      {hasStickyBuy(product) ? (
        <PdpStickyBuy product={product} priceLabel={priceLabel} inlineButtonId={INLINE_ADD_ID} />
      ) : (
        <SelectionBar />
      )}
    </>
  );
}
