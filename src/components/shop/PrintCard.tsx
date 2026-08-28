import { Link } from '@/i18n/navigation';
import { srcSet } from '@/lib/images';

type Props = {
  id: string;
  image: string;
  name: string;
  priceLabel: string;
  sizes: string;
};

/** Shared print tile for the homepage rail and hero-beat carousel — purely
    presentational (name/price are computed by the caller, which owns the
    translations and pricing config). Styled by `.prints-home-card`. */
export function PrintCard({ id, image, name, priceLabel, sizes }: Props) {
  return (
    <Link className="prints-home-card" href={`/fine-art-prints/${id}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} srcSet={srcSet(image)} sizes={sizes} alt={name} loading="lazy" width={700} height={1000} />
      <span className="prints-home-meta">
        <span className="nm">{name}</span>
        <span className="pr">{priceLabel}</span>
      </span>
    </Link>
  );
}
