/* ============================================================
   CollectionScreen — shop head + family switcher + hint + gallery.
   Server component; copy comes from i18n message catalogs.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES, VISIBLE_CATEGORY_ORDER, getProductsByCategory } from '@/lib/products';
import { assertCategoryPublic } from '@/lib/category-guard';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import type { CategorySlug } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';
import { Gallery } from './Gallery';
import { StatusFilter } from './StatusFilter';
import { richTags } from '@/components/ui/richTags';

// Bento is piloted on one category. To roll out to all, pass `bento`
// unconditionally to <Gallery> below (plan Step 6) — do NOT set this to `true`.
const BENTO_PILOT: CategorySlug = 'kubki';

export async function CollectionScreen({ slug }: { slug: CategorySlug }) {
  // Withdrawn families are not browsable — return a real 404 (no loading.tsx in
  // this route group, so notFound() yields HTTP 404, not a 200 shell).
  assertCategoryPublic(slug);

  const t = await getTranslations();
  const [base, soldIds, showroomIds] = await Promise.all([
    Promise.resolve(getProductsByCategory(slug)),
    // Sold-state overlay is best-effort: a Supabase outage must not take the
    // whole storefront down. Fall back to "nothing sold" — the checkout
    // reservation (reserve_pieces) is the real double-sale guard.
    getSoldIds().catch(() => [] as string[]),
    getShowroomIds().catch(() => [] as string[]),
  ]);
  const sold = new Set(soldIds);
  const showroom = new Set(showroomIds);
  const products = base.map((p) => {
    const merged = sold.has(p.id) ? { ...p, sold: true } : p;
    return showroom.has(p.id) ? { ...merged, showroom: true } : merged;
  });

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t(`collection.${slug}.eyebrow`)}</div>
            <h1>{t.rich(`collection.${slug}.title`, richTags)}</h1>
            <p className="lead">{t(`collection.${slug}.lead`)}</p>
          </div>
          <div className="shop-switch-row">
            <div className="shop-switch edge-fade-x">
              {VISIBLE_CATEGORY_ORDER.map((s) => (
                <Link key={s} href={`/${s}`} className={s === slug ? 'active' : undefined}>
                  {t(CATEGORIES[s].nameKey)}
                </Link>
              ))}
            </div>
            <StatusFilter />
          </div>
        </div>
      </section>

      <div className="shop-hint">
        <span className="ic"><Icon name="check" /></span>
        <p>{t.rich('collection.hint', richTags)}</p>
      </div>

      <Gallery products={products} bento={slug === BENTO_PILOT} />
    </>
  );
}
