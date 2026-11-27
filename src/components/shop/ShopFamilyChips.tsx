/* ============================================================
   ShopFamilyChips — the family filter row shared by /sklep and
   the homepage. Plain `Link`s, so filtering works without
   hydration: each chip is a full page load to /sklep?rodzina=<slug>.
   Only families with at least one piece available now get a chip;
   the family cards below the grid stay the entry point for the
   collection pages.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';
import { chipFamilies, shopFamilyHref } from '@/lib/shop-family';
import type { CeramicShopFamily } from './CeramicShopScreen';

type Props = {
  /** Every visible family summary — the row picks the ones with stock. */
  families: CeramicShopFamily[];
  /** The family currently filtered, if any (highlights the chip). */
  active?: CategorySlug | null;
  /** Render the leading "All (N)" chip that clears the filter (shop only). */
  showAll?: boolean;
};

export async function ShopFamilyChips({ families, active = null, showAll = false }: Props) {
  const t = await getTranslations();
  const chips = chipFamilies(families);
  if (!showAll && chips.length === 0) return null;
  const totalAvailable = families.reduce((sum, family) => sum + family.available, 0);

  return (
    <div className="shop-switch-row">
      <div className="shop-switch edge-fade-x" data-testid="shop-family-chips">
        {showAll && (
          <Link
            href="/sklep"
            prefetch={false}
            aria-current={active === null ? 'true' : undefined}
          >
            {t('ceramicShop.filterAll')} ({totalAvailable})
          </Link>
        )}
        {chips.map((family) => (
          <Link
            key={family.slug}
            href={shopFamilyHref(family.slug)}
            // Every chip is a distinct server-rendered URL: prefetching would
            // download one RSC payload per family on every shop view for a
            // navigation most visitors never take.
            prefetch={false}
            aria-current={active === family.slug ? 'true' : undefined}
            data-family={family.slug}
          >
            {t(CATEGORIES[family.slug].nameKey)} ({family.available})
          </Link>
        ))}
      </div>
    </div>
  );
}
