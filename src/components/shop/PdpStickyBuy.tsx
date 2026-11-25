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
 * gallery, so this bar keeps a buy control on the first screen. It hides while
 * the inline button is on screen and once the piece is in the cart; while it
 * shows, the selection bar yields the bottom slot to it (mobile only — on
 * desktop the bar is `display:none` and the selection bar behaves as usual).
 *
 * Render it only for purchasable pieces; sold / showroom PDPs keep the plain
 * <SelectionBar />.
 */
export function PdpStickyBuy({ product, priceLabel, inlineButtonId }: Props) {
  const t = useTranslations();
  const { inCart, toggle } = useCartToggle(product);
  const [inlineVisible, setInlineVisible] = useState(false);

  useEffect(() => {
    const el = document.getElementById(inlineButtonId);
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // The bottom margin keeps the bar up until the inline button has cleared
    // the strip the bar itself occupies, so the two never swap mid-overlap.
    const io = new IntersectionObserver(
      ([entry]) => setInlineVisible(entry.isIntersecting),
      { rootMargin: '0px 0px -96px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inlineButtonId]);

  const active = !inCart && !inlineVisible;

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
