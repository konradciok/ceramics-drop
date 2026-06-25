/* ============================================================
   AllPiecesScreen — shop head + sticky category jump-nav + hint
   + grouped gallery for the unified /sklep page.
   Server component; copy comes from i18n message catalogs.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { CATEGORIES, VISIBLE_CATEGORY_ORDER } from '@/lib/products';
import type { Product } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { GroupedGallery } from './GroupedGallery';
import { StatusFilter } from './StatusFilter';

export async function AllPiecesScreen({ products }: { products: Product[] }) {
  const t = await getTranslations();

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('collection.sklep.eyebrow')}</div>
            <h1>{t.rich('collection.sklep.title', richTags)}</h1>
            <p className="lead">{t('collection.sklep.lead')}</p>
          </div>
        </div>
      </section>

      {/* Full-width sticky category jump-nav. Lifted out of .shop-head so its
          sticky containing block is <main> — it stays pinned under the site
          header while the user scrolls the galleries. GroupedGallery's
          scroll-spy toggles aria-current on these anchors. */}
      <nav id="shop-nav" className="shop-nav-sticky" aria-label={t('nav.sklep')}>
        <div className="shop-nav-track has-filter">
          <div className="shop-switch">
            {VISIBLE_CATEGORY_ORDER.map((s) => (
              <a key={s} href={`#${s}`}>
                {t(CATEGORIES[s].nameKey)}
              </a>
            ))}
          </div>
          <StatusFilter />
        </div>
      </nav>

      <div className="shop-hint">
        <span className="ic"><Icon name="check" /></span>
        <p>{t.rich('collection.hint', richTags)}</p>
      </div>

      <GroupedGallery products={products} />
    </>
  );
}
