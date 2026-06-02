'use client';

import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { euro } from '@/lib/format';
import type { Product } from '@/lib/types';

type Props = {
  product: Product;
  /** Open the lightbox for this piece. */
  onOpen?: (product: Product) => void;
};

/** Gallery tile — Google-Photos-style select + a distinct "add" button. */
export function ProductTile({ product, onOpen }: Props) {
  const selected = useCart((s) => s.ids.includes(product.id));
  const toggle = useCart((s) => s.toggle);

  return (
    <div
      className={`tile${product.sold ? ' sold' : ''}${selected ? ' selected' : ''}`}
      data-id={product.id}
      onClick={() => !product.sold && onOpen?.(product)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={product.image} alt={`Nº ${product.num}`} loading="lazy" />
      <div className="veil" />
      {/* TODO (content): "sold" / "add" / "in cart" labels via i18n */}
      <span className="sold-tag">Sprzedane</span>
      <div className="check">
        <Icon name="check" />
      </div>
      <button
        className={`tile-add${selected ? ' in' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          toggle(product.id);
        }}
      >
        <span className="ic">
          <Icon name={selected ? 'check' : 'cart'} />
        </span>
        <span className="tx">{selected ? 'W koszyku' : 'Dodaj'}</span>
      </button>
      <div className="tile-meta">
        <span className="nm">Nº {product.num}</span>
        <span className="pr">{euro(product.price)}</span>
      </div>
    </div>
  );
}
