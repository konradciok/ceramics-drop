'use client';

import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { euro } from '@/lib/format';
import type { Product } from '@/lib/types';

type Props = {
  /** Available (unsold) pieces the lightbox can page through. */
  products: Product[];
  /** Index into `products`, or null when closed. */
  index: number | null;
  onClose: () => void;
  onStep: (delta: number) => void;
};

/** Product detail popup. Specs / notes copy arrives in the content phase. */
export function Lightbox({ products, index, onClose, onStep }: Props) {
  const ids = useCart((s) => s.ids);
  const toggle = useCart((s) => s.toggle);

  const open = index !== null;
  const product = open ? products[index] : undefined;
  const inCart = product ? ids.includes(product.id) : false;

  return (
    <>
      <div className={`lb-scrim${open ? ' open' : ''}`} onClick={onClose} />
      <div
        className={`lb${open ? ' open' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {product && (
          <div className="lb-card">
            <div className="lb-img">
              <button className="lb-close" onClick={onClose} aria-label="Zamknij">
                <Icon name="close" />
              </button>
              <button className="lb-nav lb-prev" onClick={() => onStep(-1)} aria-label="Poprzednia">
                <Icon name="chevron-left" />
              </button>
              <button className="lb-nav lb-next" onClick={() => onStep(1)} aria-label="Następna">
                <Icon name="chevron-right" />
              </button>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={product.image} alt={`Nº ${product.num}`} />
            </div>
            <div className="lb-body">
              <div className="eyebrow lb-eyebrow" />
              <h3>
                Nº <em>{product.num}</em>
              </h3>
              <div className="lb-price">{euro(product.price)}</div>
              {/* TODO (content): description note + specs */}
              <p className="lb-note" />
              <div className="lb-specs" />
              <button
                className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
                onClick={() => toggle(product.id)}
              >
                {inCart ? 'W koszyku' : 'Dodaj do koszyka'}
                <Icon name="arrow" className="btn-arrow" />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
