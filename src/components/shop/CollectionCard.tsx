import { Link } from '@/i18n/navigation';
import { srcSet } from '@/lib/images';

type Props = {
  slug: string;
  name: string;
  image: string;
  countLabel: string;
  teaser?: string;
  sizes: string;
};

/** Editorial card for the /kolekcje hub: cover, name, piece count and a one-line
    teaser. Purely presentational — no prices, no cart (hub is a narrative gateway,
    the shop is /sklep). Server component; the caller owns copy and data. */
export function CollectionCard({ slug, name, image, countLabel, teaser, sizes }: Props) {
  return (
    <Link className="collection-card" href={`/kolekcje/${slug}`} data-testid="collection-card">
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
