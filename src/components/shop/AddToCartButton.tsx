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

type Props = { product: Product };

/** Add-to-cart CTA for the product detail page. */
export function AddToCartButton({ product }: Props) {
  const t = useTranslations();
  const currency = useCurrency();
  const { code: analyticsCurrency } = currencyFormatter(currency);
  const ids = useCart((s) => s.ids);
  const add = useCart((s) => s.add);
  const remove = useCart((s) => s.remove);
  const inCart = ids.includes(product.id);

  if (product.sold) {
    return (
      <button className="btn btn-primary lb-add" disabled aria-disabled="true">
        {t('gallery.sold')}
      </button>
    );
  }

  return (
    <button
      className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
      onClick={() => {
        const wasPresent = useCart.getState().ids.includes(product.id);
        if (inCart) { remove(product.id); } else { add(product.id); }
        const isPresent = useCart.getState().ids.includes(product.id);
        if (wasPresent !== isPresent) {
          const analyticsOpts = { currency: analyticsCurrency, itemPrices: [priceOfCurrency(product, currency)] };
          pushDataLayer(isPresent ? buildAddToCartEvent(product, analyticsOpts) : buildRemoveFromCartEvent(product, analyticsOpts));
        }
      }}
    >
      {inCart ? t('lightbox.in') : t('lightbox.add')}
      <Icon name={inCart ? 'check' : 'arrow'} className="btn-arrow" />
    </button>
  );
}
