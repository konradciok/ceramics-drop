import { Link } from '@/i18n/navigation';
import { srcSet } from '@/lib/images';
import type { Product } from '@/lib/types';

type Props = {
  product: Product;
  displayName: string;
  soldLabel: string;
  showroomLabel: string;
  priceLabel: string;
};

/** Static linked tile used in "More from this collection" — no client state. */
export function ProductTileLink({ product, displayName, soldLabel, showroomLabel, priceLabel }: Props) {
  return (
    <Link
      href={`/${product.category}/${product.id}`}
      className={`tile-static${product.showroom ? ' showroom' : ''}`}
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
        <span>{priceLabel}</span>
      </div>
      {product.showroom ? (
        <span className="showroom-tag">{showroomLabel}</span>
      ) : product.sold ? (
        <span className="sold-tag">{soldLabel}</span>
      ) : null}
    </Link>
  );
}
