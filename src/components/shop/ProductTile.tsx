'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { pln } from '@/lib/format';
import { CATEGORIES } from '@/lib/products';
import { buildAddToCartEvent, buildRemoveFromCartEvent, pushDataLayer } from '@/lib/analytics';
import { srcSet } from '@/lib/images';
import type { Product } from '@/lib/types';

type Props = {
  product: Product;
  /** Open the lightbox for this piece. */
  onOpen?: (product: Product) => void;
};

/** Gallery tile — Google-Photos-style select + a distinct "add" button. */
export function ProductTile({ product, onOpen }: Props) {
  const t = useTranslations();
  const selected = useCart((s) => s.ids.includes(product.id));
  const add = useCart((s) => s.add);
  const remove = useCart((s) => s.remove);

  const name = t(`product.${CATEGORIES[product.category].singularKey}`);
  const displayName = `${name} Nº ${product.num}`;
  const gallery = product.gallery ?? [];

  return (
    <div
      className={`tile${product.sold ? ' sold' : ''}${selected ? ' selected' : ''}`}
      onClick={() => !product.sold && onOpen?.(product)}
      data-testid="product-tile"
      data-product-id={product.id}
      data-category={product.category}
      data-price={product.price}
      data-sold={product.sold ? 'true' : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={product.image} srcSet={srcSet(product.image)} sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw" alt={displayName} loading="lazy" />
      {gallery.length > 0 && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="tile-alt" src={gallery[0]} srcSet={srcSet(gallery[0])} sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw" alt="" aria-hidden="true" loading="lazy" />
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
        disabled={product.sold}
        aria-disabled={product.sold}
        onClick={(e) => {
          e.stopPropagation();
          if (product.sold) return;
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
            pushDataLayer(isPresent ? buildAddToCartEvent(product) : buildRemoveFromCartEvent(product));
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
        <span className="pr">{pln(product.price)}</span>
      </div>
    </div>
  );
}
