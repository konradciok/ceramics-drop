'use client';

import { useState } from 'react';
import type { Product } from '@/lib/types';
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
            onOpen={(prod) =>
              setOpenIndex(available.findIndex((a) => a.id === prod.id))
            }
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
