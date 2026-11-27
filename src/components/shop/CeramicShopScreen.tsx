/* ============================================================
   CeramicShopScreen — /sklep, the ceramics shop.
   The pieces on sale now across all visible families (family order),
   then a card per family linking into its collection page, then every
   listed piece that cannot be bought right now — sold, reserved by an
   open checkout, showroom — each badged with its real state.
   `?rodzina=<slug>` narrows both piece sections to one family.
   Server component; copy comes from the `ceramicShop` namespace.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import {
  CATEGORIES,
  VISIBLE_CATEGORY_ORDER,
  getPublicProducts,
  isProductListed,
  isProductPurchasable,
} from '@/lib/products';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import type { CategorySlug, Product } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { showsShopEmptyNotice } from '@/lib/shop-family';
import { CollectionCard } from './CollectionCard';
import { Gallery } from './Gallery';
import { ShopFamilyChips } from './ShopFamilyChips';

export type CeramicShopFamily = {
  slug: (typeof VISIBLE_CATEGORY_ORDER)[number];
  cover: string | undefined;
  total: number;
  available: number;
};

/**
 * Splits the public catalogue into the pieces on sale now and the ones that
 * cannot be bought right now (sold, reserved by a checkout, showroom), both in
 * family order, plus one summary per visible family. Exported for unit tests.
 *
 * With `family`, both piece lists narrow to that one family (the
 * `?rodzina=<slug>` chip filter); the `families` summaries stay complete so the
 * chip row and the family cards keep every family.
 */
export function summariseCeramicShop(
  products: Product[],
  family?: CategorySlug | null,
): {
  available: Product[];
  unavailable: Product[];
  families: CeramicShopFamily[];
} {
  const available: Product[] = [];
  const unavailable: Product[] = [];
  const families: CeramicShopFamily[] = [];
  for (const slug of VISIBLE_CATEGORY_ORDER) {
    const inFamily = products.filter((p) => p.category === slug);
    if (inFamily.length === 0) continue;
    const onSale = inFamily.filter(isProductPurchasable);
    families.push({ slug, cover: inFamily[0]?.image, total: inFamily.length, available: onSale.length });
    if (family && family !== slug) continue;
    available.push(...onSale);
    unavailable.push(...inFamily.filter((p) => !isProductPurchasable(p)));
  }
  return { available, unavailable, families };
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

export async function CeramicShopScreen({
  products,
  family = null,
}: {
  products: Product[];
  /** Validated `?rodzina=` slug, or null for the whole shop. */
  family?: CategorySlug | null;
}) {
  const t = await getTranslations();
  const { available, unavailable, families } = summariseCeramicShop(products, family);

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('ceramicShop.eyebrow')}</div>
            <h1>{t.rich('ceramicShop.title', richTags)}</h1>
            <p className="lead">{t('ceramicShop.lead')}</p>
          </div>
          <ShopFamilyChips families={families} active={family} showAll />
        </div>
      </section>

      <section className="section ceramic-shop-available" data-testid="ceramic-shop-available">
        <div className="section-inner">
          {/* Owner-approved copy: the count is appended only while a family is
              chosen, e.g. "Dostępne teraz (47)"; the unfiltered heading stays
              exactly as written. */}
          <h2 className="gallery-group-head">
            {family
              ? t('ceramicShop.availableTitleFiltered', { count: available.length })
              : t('ceramicShop.availableTitle')}
          </h2>
        </div>
        {available.length > 0 && (
          <div className="shop-hint">
            <span className="ic"><Icon name="check" /></span>
            <p>{t.rich('collection.hint', richTags)}</p>
          </div>
        )}
        {showsShopEmptyNotice(family, available.length) && (
          <div className="section-inner">
            <p className="shop-empty">{t('ceramicShop.availableEmpty')}</p>
          </div>
        )}
        {/* Purchasable only — sold/reserved pieces get their own section below
            the family cards. No status filter here: a stored "sold" view must
            not narrow /sklep. The list id names the filtered family so
            `view_item_list`/`select_item` show which chips sell. */}
        {available.length > 0 && (
          <Gallery
            products={available}
            listId={family ? `sklep-${family}` : 'sklep'}
            filterable={false}
          />
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
        </div>
      </section>

      {unavailable.length > 0 && (
        <section className="section ceramic-shop-unavailable" data-testid="ceramic-shop-unavailable">
          <div className="section-inner">
            <h2 className="gallery-group-head">{t('ceramicShop.unavailableTitle')}</h2>
          </div>
          <Gallery products={unavailable} listId="sklep-unavailable" filterable={false} />
        </section>
      )}
    </>
  );
}
