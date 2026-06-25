'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { buildViewItemEvent, pushDataLayer } from '@/lib/analytics';
import { priceOf } from '@/lib/pricing';
import type { Product } from '@/lib/types';

type Props = { product: Product };

/** Fires view_item on PDP load — mirrors the event Lightbox fires on open. */
export function ProductViewAnalytics({ product }: Props) {
  const locale = useLocale();
  const analyticsCurrency = locale === 'pl' ? 'PLN' as const : locale === 'gb' ? 'GBP' as const : 'EUR' as const;

  useEffect(() => {
    pushDataLayer(
      buildViewItemEvent(product, {
        itemListId: product.category,
        itemListName: product.category,
        currency: analyticsCurrency,
        priceOverride: priceOf(product, locale),
      }),
    );
    // product.id is the stable key; if the page somehow remounts with a different
    // product the event re-fires — intentional for SPA-style navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  return null;
}
