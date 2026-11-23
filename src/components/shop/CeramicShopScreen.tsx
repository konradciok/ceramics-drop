/* ============================================================
   CeramicShopScreen — /sklep, the ceramics shop.
   Every currently purchasable one-of-a-kind piece across all
   visible families (one gallery, so the lightbox steps through
   everything on sale), then a card per family linking into its
   full collection page (sold pieces included there).
   Server component; copy comes from the `ceramicShop` namespace.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import {
  CATEGORIES,
  VISIBLE_CATEGORY_ORDER,
  getPublicProducts,
  isProductListed,
  isProductPurchasable,
} from '@/lib/products';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import { printShopUrl } from '@/lib/site';
import type { Product } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { CollectionCard } from './CollectionCard';
import { Gallery } from './Gallery';

export type CeramicShopFamily = {
  slug: (typeof VISIBLE_CATEGORY_ORDER)[number];
  cover: string | undefined;
  total: number;
  available: number;
};

/**
 * Splits the public catalogue into the pieces on sale now (in family order)
 * and one summary per visible family. Exported for unit tests.
 */
export function summariseCeramicShop(products: Product[]): {
  available: Product[];
  families: CeramicShopFamily[];
} {
  const available: Product[] = [];
  const families: CeramicShopFamily[] = [];
  for (const slug of VISIBLE_CATEGORY_ORDER) {
    const inFamily = products.filter((p) => p.category === slug);
    if (inFamily.length === 0) continue;
    const onSale = inFamily.filter(isProductPurchasable);
    available.push(...onSale);
    families.push({ slug, cover: inFamily[0]?.image, total: inFamily.length, available: onSale.length });
  }
  return { available, families };
}

/**
 * Public catalogue with the live sold/showroom overlay applied — same
 * best-effort contract as CollectionScreen: an inventory outage must not take
 * the shop down; checkout's reserve_pieces is the real double-sale guard.
 */
export async function loadCeramicShopProducts(): Promise<Product[]> {
  const [base, soldIds, showroomIds] = await Promise.all([
    getPublicProducts(),
    getSoldIds().catch(() => [] as string[]),
    getShowroomIds().catch(() => [] as string[]),
  ]);
  const sold = new Set(soldIds);
  const showroom = new Set(showroomIds);
  // The shop lists the active drop only; ended drops live on /showroom.
  return base.filter(isProductListed).map((p) => {
    const merged = sold.has(p.id) ? { ...p, sold: true } : p;
    return showroom.has(p.id) ? { ...merged, showroom: true } : merged;
  });
}

export async function CeramicShopScreen({ locale, products }: { locale: string; products: Product[] }) {
  const t = await getTranslations();
  const { available, families } = summariseCeramicShop(products);

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('ceramicShop.eyebrow')}</div>
            <h1>{t.rich('ceramicShop.title', richTags)}</h1>
            <p className="lead">{t('ceramicShop.lead')}</p>
          </div>
          <div className="shop-switch-row">
            <div className="shop-switch edge-fade-x">
              {VISIBLE_CATEGORY_ORDER.map((s) => (
                <Link key={s} href={`/${s}`}>
                  {t(CATEGORIES[s].nameKey)}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section ceramic-shop-available" data-testid="ceramic-shop-available">
        <div className="section-inner">
          <h2 className="gallery-group-head">{t('ceramicShop.availableTitle', { count: available.length })}</h2>
        </div>
        {available.length > 0 ? (
          <>
            <div className="shop-hint">
              <span className="ic"><Icon name="check" /></span>
              <p>{t.rich('collection.hint', richTags)}</p>
            </div>
            <Gallery products={available} listId="sklep" filterable={false} />
          </>
        ) : (
          <div className="section-inner">
            <p className="shop-empty">{t('ceramicShop.availableEmpty')}</p>
          </div>
        )}
      </section>

      <section className="section collections-hub" data-testid="ceramic-shop-families">
        <div className="section-inner">
          <h2 className="gallery-group-head">{t('ceramicShop.familiesTitle')}</h2>
          <div className="collections-hub-grid">
            {families.map((f) =>
              f.cover ? (
                <CollectionCard
                  key={f.slug}
                  href={`/${f.slug}`}
                  name={t(CATEGORIES[f.slug].nameKey)}
                  image={f.cover}
                  countLabel={t('ceramicShop.familyCount', { count: f.total, available: f.available })}
                  sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
                />
              ) : null,
            )}
          </div>
          <div className="collections-hub-cta">
            <a className="section-link" href={printShopUrl(locale)}>
              <span>{t('ceramicShop.printsCta')}</span> <Icon name="arrow" />
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
