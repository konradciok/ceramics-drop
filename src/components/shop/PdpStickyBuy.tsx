'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { useCartToggle } from './AddToCartButton';
import { SelectionBar } from './SelectionBar';
import type { Product } from '@/lib/types';

type Props = {
  product: Product;
  priceLabel: string;
  /** DOM id of the inline add-to-cart button this bar stands in for. */
  inlineButtonId: string;
};

/**
 * Mobile-only sticky "price + add to cart" bar for a purchasable PDP, plus the
 * page's selection bar. On a phone the inline button sits far below the
 * gallery, so this bar keeps a buy control on the first screen. It shows only
 * while the inline button is still below the viewport and the piece is not in
 * the cart: once the visitor reaches the inline button or scrolls past it
 * (into "more from", the footer), the bar leaves for good on that pass, so it
 * never covers the footer and the selection bar's checkout link comes back for
 * a visitor who already holds other pieces. While the bar shows, the selection
 * bar yields the bottom slot to it (mobile only — on desktop the bar is
 * `display:none` and the selection bar behaves as usual).
 *
 * Render it only for purchasable pieces; sold / showroom PDPs keep the plain
 * <SelectionBar />.
 */
export function PdpStickyBuy({ product, priceLabel, inlineButtonId }: Props) {
  const t = useTranslations();
  const { inCart, toggle } = useCartToggle(product);
  // Until the observer reports, assume the inline button is below the fold
  // (it always is on a phone) so the bar is there on the first screen.
  const [inlineBelow, setInlineBelow] = useState(true);

  useEffect(() => {
    const el = document.getElementById(inlineButtonId);
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // The bottom margin keeps the bar up until the inline button has cleared
    // the strip the bar itself occupies, so the two never swap mid-overlap.
    const io = new IntersectionObserver(
      ([entry]) => {
        const bottomEdge = entry.rootBounds?.bottom ?? window.innerHeight;
        setInlineBelow(!entry.isIntersecting && entry.boundingClientRect.top >= bottomEdge);
      },
      { rootMargin: '0px 0px -96px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inlineButtonId]);

  const active = !inCart && inlineBelow;

  return (
    <>
      <div
        className={`pdp-buybar${active ? ' show' : ''}`}
        data-testid="pdp-buybar"
        aria-hidden={!active}
        inert={!active}
      >
        <div className="pdp-buybar-inner">
          <span className="pdp-buybar-price">{priceLabel}</span>
          <button className="pdp-buybar-add" data-testid="pdp-buybar-add" onClick={toggle}>
            {t('lightbox.add')} <Icon name="arrow" />
          </button>
        </div>
      </div>
      <SelectionBar yieldOnMobile={active} />
    </>
  );
}
