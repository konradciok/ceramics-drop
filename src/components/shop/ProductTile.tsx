'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { euro } from '@/lib/format';
import { CATEGORIES } from '@/lib/products';
import { buildAddToCartEvent, buildRemoveFromCartEvent, pushDataLayer } from '@/lib/analytics';
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

  return (
    <div
      className={`tile${product.sold ? ' sold' : ''}${selected ? ' selected' : ''}`}
      onClick={() => !product.sold && onOpen?.(product)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={product.image} alt={displayName} loading="lazy" />
      <div className="veil" />
      <span className="sold-tag">{t('gallery.sold')}</span>
      <div className="check">
        <Icon name="check" />
      </div>
      <button
        className={`tile-add${selected ? ' in' : ''}`}
        disabled={product.sold}
        aria-disabled={product.sold}
        onClick={(e) => {
          e.stopPropagation();
          if (product.sold) return;
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
        <span className="pr">{euro(product.price)}</span>
      </div>
    </div>
  );
}
