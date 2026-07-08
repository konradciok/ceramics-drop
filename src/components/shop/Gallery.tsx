'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFilter } from '@/store/filter';
import { filterByStatus } from '@/lib/status-filter';
import { useMounted } from '@/lib/use-mounted';
import type { Product } from '@/lib/types';
import { buildSelectItemEvent, buildViewItemListEvent, pushDataLayer } from '@/lib/analytics';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { featureKind } from '@/lib/bento';
import { ProductTile } from './ProductTile';
import { Lightbox } from './Lightbox';
import { SelectionBar } from './SelectionBar';

type Props = {
  products: Product[];
  bento?: boolean;
};

/** The collection gallery: grid of tiles + lightbox + selection bar. */
export function Gallery({ products, bento = false }: Props) {
  const currency = useCurrency();
  const { code: analyticsCurrency } = currencyFormatter(currency);
  // Memoised so the array reference is stable across renders (only changes when
  // the `products` prop changes), which lets us use `available` directly in
  // useEffect deps without triggering the effect on every render.
  const available = useMemo(() => products.filter((p) => !p.sold), [products]);
  const t = useTranslations();
  const mounted = useMounted();
  const storedStatus = useFilter((s) => s.status);
  const status = mounted ? storedStatus : 'all';
  // Rendered tiles. `available` stays the full unsold set (lightbox/analytics
  // index space) — sold tiles are never clickable, so it is unaffected by view.
  const visible = useMemo(() => filterByStatus(products, status), [products, status]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // Derive listId from the full products array so it remains stable even when
  // every piece in the category is sold (available[0] would be undefined then).
  const listId = products[0]?.category ?? 'collection';
  const listName = listId;

  // Tracks whichever tile button triggered the lightbox open so focus can
  // return to it when the lightbox closes.
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Emit view_item_list only when there are purchasable items to show; index
    // space must match select_item / view_item which both operate on `available`.
    if (available.length === 0) return;
    pushDataLayer(
      buildViewItemListEvent(available, {
        itemListId: listId,
        itemListName: listName,
        currency: analyticsCurrency,
        itemPrices: available.map((p) => priceOfCurrency(p, currency)),
      }),
    );
    // Fire once per list; currency is captured at first paint (a currency switch
    // shouldn't re-emit view_item_list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, listName, available]);

  const step = (delta: number) =>
    setOpenIndex((i) =>
      i === null ? i : (i + delta + available.length) % available.length,
    );

  return (
    <>
      {visible.length === 0 ? (
        <p className="shop-empty">
          {status === 'sold' ? t('filter.emptySold') : t('filter.emptyAvailable')}
        </p>
      ) : (
        <div className={`gallery${bento ? ' gallery--bento' : ''}`} data-count={visible.length}>
          {visible.map((p, i) => (
            <ProductTile
              key={p.id}
              product={p}
              feature={bento ? featureKind(i) : undefined}
              reveal={bento}
              onOpen={(prod) => {
                // Capture the focused element (the tile button) before state update
                triggerRef.current = document.activeElement as HTMLElement;
                const index = available.findIndex((a) => a.id === prod.id);
                pushDataLayer(
                  buildSelectItemEvent(prod, {
                    index,
                    itemListId: listId,
                    itemListName: listName,
                    currency: analyticsCurrency,
                    priceOverride: priceOfCurrency(prod, currency),
                  }),
                );
                setOpenIndex(index);
              }}
            />
          ))}
        </div>
      )}

      <Lightbox
        products={available}
        index={openIndex}
        onClose={() => setOpenIndex(null)}
        onStep={step}
        triggerRef={triggerRef}
      />
      <SelectionBar />
    </>
  );
}
