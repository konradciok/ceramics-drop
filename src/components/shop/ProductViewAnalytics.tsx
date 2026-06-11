'use client';

import { useEffect } from 'react';
import { buildViewItemEvent, pushDataLayer } from '@/lib/analytics';
import type { Product } from '@/lib/types';

type Props = { product: Product };

/** Fires view_item on PDP load — mirrors the event Lightbox fires on open. */
export function ProductViewAnalytics({ product }: Props) {
  useEffect(() => {
    pushDataLayer(
      buildViewItemEvent(product, {
        itemListId: product.category,
        itemListName: product.category,
      }),
    );
    // product.id is the stable key; if the page somehow remounts with a different
    // product the event re-fires — intentional for SPA-style navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  return null;
}
