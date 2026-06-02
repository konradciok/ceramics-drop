'use client';

import { useEffect, useState } from 'react';
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
  const available = products.filter((p) => !p.sold);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const listId = products[0]?.category ?? 'collection';
  const listName = listId;

  useEffect(() => {
    if (products.length === 0) return;
    pushDataLayer(
      buildViewItemListEvent(products, {
        itemListId: listId,
        itemListName: listName,
      }),
    );
  }, [listId, listName, products]);

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
      />
      <SelectionBar />
    </>
  );
}
