import { Link } from '@/i18n/navigation';
import { srcSet } from '@/lib/images';
import { pln } from '@/lib/format';
import type { Product } from '@/lib/types';

type Props = {
  product: Product;
  displayName: string;
  soldLabel: string;
};

/** Static linked tile used in "More from this collection" — no client state. */
export function ProductTileLink({ product, displayName, soldLabel }: Props) {
  return (
    <Link
      href={`/${product.category}/${product.id}`}
      className="tile-static"
      aria-label={displayName}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={product.image}
        srcSet={srcSet(product.image)}
        sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
        alt={displayName}
        loading="lazy"
      />
      <div className="tile-static-meta">
        <span>{displayName}</span>
        <span>{pln(product.price)}</span>
      </div>
      {product.sold && <span className="sold-tag">{soldLabel}</span>}
    </Link>
  );
}
