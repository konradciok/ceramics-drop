import { Link } from '@/i18n/navigation';
import { srcSet } from '@/lib/images';

type Props = {
  /** Locale-relative path (the i18n Link adds the prefix), e.g. `/kubki`. */
  href: string;
  name: string;
  image: string;
  countLabel: string;
  teaser?: string;
  sizes: string;
};

/** Editorial card (used for the ceramic families on /sklep): cover, name, piece
    count and an optional one-line teaser. Purely presentational — no prices, no
    cart. Server component; the caller owns copy and data. */
export function CollectionCard({ href, name, image, countLabel, teaser, sizes }: Props) {
  return (
    <Link className="collection-card" href={href} data-testid="collection-card">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} srcSet={srcSet(image)} sizes={sizes} alt="" loading="lazy" width={700} height={1000} />
      <span className="collection-card-meta">
        <span className="nm">{name}</span>
        <span className="ct">{countLabel}</span>
      </span>
      {teaser && <span className="collection-card-teaser">{teaser}</span>}
    </Link>
  );
}
