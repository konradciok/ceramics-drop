'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { isPrintToken } from '@/lib/print-cart';
import { CATEGORIES } from '@/lib/products';
import {
  buildAddToCartEvent,
  buildEngagementEvent,
  buildRemoveFromCartEvent,
  pushDataLayer,
  toAnalyticsItem,
} from '@/lib/analytics';
import { srcSet } from '@/lib/images';
import type { Product } from '@/lib/types';

type Props = {
  product: Product;
  /** Open the lightbox for this piece. */
  onOpen?: (product: Product) => void;
  feature?: 'lead' | 'wide';
  reveal?: boolean;
};

/** Gallery tile — Google-Photos-style select + a distinct "add" button. */
export function ProductTile({ product, onOpen, feature, reveal }: Props) {
  const t = useTranslations();
  const currency = useCurrency();
  const { fmt, code: analyticsCurrency } = currencyFormatter(currency);
  const ids = useCart((s) => s.ids);
  const selected = ids.includes(product.id);
  const cartHasPrints = ids.some(isPrintToken);
  const addBlocked = cartHasPrints && !selected;
  const add = useCart((s) => s.add);
  const remove = useCart((s) => s.remove);

  const name = t(`product.${CATEGORIES[product.category].singularKey}`);
  const displayName = `${name} Nº ${product.num}`;
  const gallery = product.gallery ?? [];

  const sizes =
    feature === 'lead' ? '(min-width:1101px) 50vw, (min-width:561px) 66vw, 100vw'
    : feature === 'wide' ? '(min-width:1101px) 50vw, (min-width:561px) 66vw, 50vw'
    : '(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw';

  return (
    <div
      className={`tile${product.sold ? ' sold' : ''}${selected ? ' selected' : ''}${feature ? ` tile--${feature}` : ''}${reveal ? ' reveal' : ''}`}
      onClick={() => {
        if (product.sold) {
          // Demand signal for already-sold pieces — important for drops. The tile
          // is otherwise a no-op (sold pieces don't open the lightbox). Reuse
          // toAnalyticsItem so item_name/price match every other ecommerce event
          // and stay locale-independent (so PL/EN/ES clicks aggregate as one piece).
          const item = toAnalyticsItem(product);
          pushDataLayer(
            buildEngagementEvent('sold_item_view', {
              item_id: item.item_id,
              item_name: item.item_name,
              item_category: item.item_category,
              price: item.price,
            }),
          );
          return;
        }
        onOpen?.(product);
      }}
      data-testid="product-tile"
      data-product-id={product.id}
      data-category={product.category}
      data-price={priceOfCurrency(product, currency)}
      data-sold={product.sold ? 'true' : undefined}
    >
      {/* Crawlable href for search engines; JS click is intercepted by the div handler above */}
      <Link
        href={`/${product.category}/${product.id}`}
        className="tile-link"
        tabIndex={product.sold ? 0 : -1}
        aria-hidden={!product.sold}
        // Unsold: prevent navigation so the div's onClick opens the lightbox instead.
        // Sold: let the link through — the PDP is the natural fallback destination.
        onClick={(e) => { if (!product.sold) e.preventDefault(); }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={product.image} srcSet={srcSet(product.image)} sizes={sizes} alt={displayName} loading="lazy" />
      {gallery.length > 0 && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="tile-alt" src={gallery[0]} srcSet={srcSet(gallery[0])} sizes={sizes} alt="" aria-hidden="true" loading="lazy" />
          <span className="tile-multi" aria-hidden="true">{gallery.length + 1}</span>
        </>
      )}
      <div className="veil" />
      <span className="sold-tag">{t('gallery.sold')}</span>
      <div className="check">
        <Icon name="check" />
      </div>
      <button
        className={`tile-add${selected ? ' in' : ''}`}
        data-testid="add-to-cart"
        disabled={product.sold || addBlocked}
        aria-disabled={product.sold || addBlocked}
        onClick={(e) => {
          e.stopPropagation();
          if (product.sold || addBlocked) return;
          // Gate the analytics event on the real store transition, not the `selected`
          // render snapshot (which can be stale) — add() is idempotent, so a no-op add
          // must not fire a duplicate add_to_cart. set() is synchronous, so getState()
          // after the call sees the post-mutation state.
          const wasPresent = useCart.getState().ids.includes(product.id);
          if (selected) {
            remove(product.id);
          } else {
            add(product.id);
          }
          const isPresent = useCart.getState().ids.includes(product.id);
          if (wasPresent !== isPresent) {
            const analyticsOpts = { currency: analyticsCurrency, itemPrices: [priceOfCurrency(product, currency)] };
            pushDataLayer(isPresent ? buildAddToCartEvent(product, analyticsOpts) : buildRemoveFromCartEvent(product, analyticsOpts));
          }
        }}
      >
        <span className="ic">
          <Icon name={selected ? 'check' : 'cart'} />
        </span>
        <span className="tx">{selected ? t('lightbox.in') : t('lightbox.add')}</span>
      </button>
      <div className="tile-meta">
        <span className="nm">{displayName}</span>
        <span className="pr">{fmt(priceOfCurrency(product, currency))}</span>
      </div>
    </div>
  );
}
