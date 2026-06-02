/* ============================================================
   CollectionScreen — shop head + family switcher + hint + gallery.
   Server component; copy comes from i18n message catalogs.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES, CATEGORY_ORDER, getProductsByCategory } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';
import { Gallery } from './Gallery';
import { richTags } from '@/components/ui/richTags';

export async function CollectionScreen({ slug }: { slug: CategorySlug }) {
  const t = await getTranslations();
  const products = getProductsByCategory(slug);

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t(`collection.${slug}.eyebrow`)}</div>
            <h1>{t.rich(`collection.${slug}.title`, richTags)}</h1>
            <p className="lead">{t(`collection.${slug}.lead`)}</p>
          </div>
          <div className="shop-switch">
            {CATEGORY_ORDER.map((s) => (
              <Link key={s} href={`/${s}`} className={s === slug ? 'active' : undefined}>
                {t(CATEGORIES[s].nameKey)}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <div className="shop-hint">
        <span className="ic"><Icon name="check" /></span>
        <p>{t.rich('collection.hint', richTags)}</p>
      </div>

      <Gallery products={products} />
    </>
  );
}
