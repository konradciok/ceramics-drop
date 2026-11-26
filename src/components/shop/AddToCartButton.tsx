'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import {
  buildAddToCartEvent,
  buildRemoveFromCartEvent,
  pushDataLayer,
} from '@/lib/analytics';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import type { Product } from '@/lib/types';
import { isProductPurchasable } from '@/lib/products';
import { unavailableLabelKey } from '@/lib/status-filter';

/**
 * Cart membership + add/remove toggle for one piece, with the matching
 * add_to_cart / remove_from_cart dataLayer event. Shared by the inline PDP
 * button and the mobile sticky buy bar so both fire the same analytics.
 */
export function useCartToggle(product: Product) {
  const currency = useCurrency();
  const { code: analyticsCurrency } = currencyFormatter(currency);
  const inCart = useCart((s) => s.ids.includes(product.id));
  const add = useCart((s) => s.add);
  const remove = useCart((s) => s.remove);

  const toggle = () => {
    const wasPresent = useCart.getState().ids.includes(product.id);
    if (wasPresent) { remove(product.id); } else { add(product.id); }
    const isPresent = useCart.getState().ids.includes(product.id);
    if (wasPresent !== isPresent) {
      const analyticsOpts = { currency: analyticsCurrency, itemPrices: [priceOfCurrency(product, currency)] };
      pushDataLayer(isPresent ? buildAddToCartEvent(product, analyticsOpts) : buildRemoveFromCartEvent(product, analyticsOpts));
    }
  };

  return { inCart, toggle };
}

type Props = {
  product: Product;
  /** DOM id — the mobile sticky buy bar watches this button's visibility. */
  id?: string;
};

/** Add-to-cart CTA for the product detail page. */
export function AddToCartButton({ product, id }: Props) {
  const t = useTranslations();
  const { inCart, toggle } = useCartToggle(product);

  if (!isProductPurchasable(product)) {
    return (
      <button id={id} className="btn btn-primary lb-add" disabled aria-disabled="true" data-testid="ceramic-add">
        {t(unavailableLabelKey(product))}
      </button>
    );
  }

  return (
    <button
      id={id}
      className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
      data-testid="ceramic-add"
      onClick={toggle}
    >
      {inCart ? t('lightbox.in') : t('lightbox.add')}
      <Icon name={inCart ? 'check' : 'arrow'} className="btn-arrow" />
    </button>
  );
}
