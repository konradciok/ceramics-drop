'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '@/lib/types';
import { buildSelectItemEvent, buildViewItemListEvent, pushDataLayer } from '@/lib/analytics';
import { ProductTile } from './ProductTile';
import { Lightbox } from './Lightbox';
import { SelectionBar } from './SelectionBar';

type Props = {
  products: Product[];
};

/** The collection gallery: grid of tiles + lightbox + selection bar. */
export function Gallery({ products }: Props) {
  // Memoised so the array reference is stable across renders (only changes when
  // the `products` prop changes), which lets us use `available` directly in
  // useEffect deps without triggering the effect on every render.
  const available = useMemo(() => products.filter((p) => !p.sold), [products]);
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
      }),
    );
  }, [listId, listName, available]);

  const step = (delta: number) =>
    setOpenIndex((i) =>
      i === null ? i : (i + delta + available.length) % available.length,
    );

  return (
    <>
      <div className="gallery" data-count={products.length}>
        {products.map((p) => (
          <ProductTile
            key={p.id}
            product={p}
            onOpen={(prod) => {
              // Capture the focused element (the tile button) before state update
              triggerRef.current = document.activeElement as HTMLElement;
              const index = available.findIndex((a) => a.id === prod.id);
              pushDataLayer(
                buildSelectItemEvent(prod, {
                  index,
                  itemListId: listId,
                  itemListName: listName,
                }),
              );
              setOpenIndex(index);
            }}
          />
        ))}
      </div>

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
