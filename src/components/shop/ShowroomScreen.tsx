/* ============================================================
   ShowroomScreen — dedicated gallery of retired (showroom) pieces.
   Each card shows the piece, its drop label, price for context, a
   "request a similar piece" form, and a link to the normal PDP.
   Server component; the interest form + view analytics are client islands.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES } from '@/lib/products';
import { srcSet } from '@/lib/images';
import { richTags } from '@/components/ui/richTags';
import type { ShowroomEntry } from '@/lib/inventory';
import { Gallery } from './Gallery';
import { EMAIL } from '@/lib/email-addresses';
import { ShowroomViewAnalytics } from './ShowroomViewAnalytics';

export async function ShowroomScreen({ entries }: { entries: ShowroomEntry[] }) {
  const t = await getTranslations();
  const online = entries.filter(({ product }) => product.onlineAvailable === true);
  const archive = entries.filter(({ product }) => product.onlineAvailable !== true);

  return (
    <>
      <ShowroomViewAnalytics count={entries.length} />
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('showroom.eyebrow')}</div>
            <h1>{t.rich('showroom.title', richTags)}</h1>
            <p className="lead">{t('showroom.lead')}</p>
            <p>{t('ceramics.visit')}</p>
            <a className="btn btn-primary" href={`mailto:${EMAIL.contact}`}>{t('ceramics.visitCta')}</a>
          </div>
        </div>
      </section>

      {online.length > 0 ? (
        <section aria-labelledby="ceramics-online-title">
          <div className="shop-head"><h2 id="ceramics-online-title">{t('ceramics.dropTitle')}</h2><p>{t('ceramics.dropLead')}</p></div>
          <Gallery products={online.map(({ product }) => product)} />
        </section>
      ) : <p className="shop-hint">{t(entries.some(({ product }) => product.saleState === 'unknown') ? 'ceramics.availabilityError' : 'ceramics.noDrop')}</p>}
      <div className="shop-head"><h2>{t('ceramics.archiveTitle')}</h2><p>{t('ceramics.archiveLead')}</p></div>
      {entries.length === 0 ? (
        <p className="shop-empty">{t('showroom.empty')}</p>
      ) : (
        <div className="showroom-grid">
          {archive.map(({ product, dropLabel }) => {
            const cat = CATEGORIES[product.category];
            const name = t(`product.${cat.singularKey}`);
            const displayName = `${name} Nº ${product.num}`;
            return (
              <div className="showroom-card" data-testid="showroom-card" data-product-id={product.id} key={product.id}>
                <Link href={`/${product.category}/${product.id}`} className="showroom-card-media" aria-label={displayName}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={product.image}
                    srcSet={srcSet(product.image)}
                    sizes="(min-width:1101px) 33vw, (min-width:561px) 50vw, 100vw"
                    alt={displayName}
                    loading="lazy"
                  />
                  <span className="showroom-tag">{t('ceramics.archived')}</span>
                </Link>
                <div className="showroom-card-body">
                  <div className="eyebrow">{dropLabel ?? t(cat.nameKey)}</div>
                  <h3>
                    <Link href={`/${product.category}/${product.id}`}>{displayName}</Link>
                  </h3>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
