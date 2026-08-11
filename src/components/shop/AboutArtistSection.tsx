/* Full-width "About the Artist" band (single global artist — Anna Ciok).
   Content comes from the print-pdp CMS document / messages fallback; an empty
   bio hides the whole section (no empty placeholders). */
import { srcSet } from '@/lib/images';
import { splitParagraphs } from '@/lib/cms/print-pdp';
import type { EditorialImage } from '@/lib/editorial-images';

export function AboutArtistSection({
  title,
  name,
  bio,
  image,
}: {
  title: string;
  name: string;
  bio: string;
  image: EditorialImage;
}) {
  if (!bio.trim()) return null;
  return (
    <section className="section about-artist">
      <div className="about-artist-inner">
        <div className="section-eyebrow">{title}</div>
        {name.trim() !== '' && <h2 className="section-title">{name}</h2>}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          srcSet={srcSet(image.src)}
          sizes="(min-width:861px) 360px, 70vw"
          alt={name.trim() !== '' ? name : title}
          width={image.width}
          height={image.height}
          loading="lazy"
        />
        <div className="about-artist-bio">
          {splitParagraphs(bio).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </div>
    </section>
  );
}
