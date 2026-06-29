/* ============================================================
   PrintCollectionScreen — fine-art-prints listing (server component).
   ------------------------------------------------------------
   Unlike the ceramic Gallery, print tiles do NOT add to cart directly:
   a variant (size/paper/frame) must be chosen first, so each tile links
   straight to the print PDP. Prices are shown as "from X / from Y".
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getPrintDesigns } from '@/lib/prints';
import { PRICE_EUR } from '@/lib/pricing';
import { eur, pln } from '@/lib/format';
import { srcSet } from '@/lib/images';
import { richTags } from '@/components/ui/richTags';
import type { Locale } from '@/i18n/routing';

const SLUG = 'fine-art-prints';

export async function PrintCollectionScreen({ locale }: { locale: Locale }) {
  const t = await getTranslations();
  const designs = getPrintDesigns();
  const isPl = locale === 'pl';

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t(`collection.${SLUG}.eyebrow`)}</div>
            <h1>{t.rich(`collection.${SLUG}.title`, richTags)}</h1>
            <p className="lead">{t(`collection.${SLUG}.lead`)}</p>
          </div>
        </div>
      </section>

      <div className="gallery" data-count={designs.length}>
        {designs.map((d) => {
          const from = isPl ? pln(d.fromPLN) : eur(PRICE_EUR[SLUG]);
          const name = `${t('product.print')} Nº ${d.num}`;
          return (
            <Link
              key={d.id}
              href={`/${SLUG}/${d.id}`}
              className="tile tile-print"
              data-product-id={d.id}
              data-testid="print-tile"
              aria-label={name}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={d.image}
                srcSet={srcSet(d.image)}
                sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
                alt={name}
                loading="lazy"
              />
              <div className="tile-meta">
                <span className="nm">{name}</span>
                <span className="pr">{t('print.from', { price: from })}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
