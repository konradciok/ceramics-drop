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
import { isPrintToken } from '@/lib/print-cart';
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
  // Mirror of PrintConfigurator's guard: ceramics and prints are separate
  // orders — block adding a ceramic while the cart holds prints (the cart view
  // and server validateCart enforce it too; this just surfaces it earlier).
  const cartHasPrints = ids.some(isPrintToken);

  if (product.sold) {
    return (
      <button className="btn btn-primary lb-add" disabled aria-disabled="true" data-testid="ceramic-add">
        {t('gallery.sold')}
      </button>
    );
  }

  if (cartHasPrints && !inCart) {
    return (
      <>
        <button className="btn btn-primary lb-add" disabled aria-disabled="true" data-testid="ceramic-add">
          {t('lightbox.add')}
        </button>
        <p className="pay-error" data-testid="ceramic-mixed-note">{t('ceramic.mixedCart')}</p>
      </>
    );
  }

  return (
    <button
      className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
      data-testid="ceramic-add"
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
