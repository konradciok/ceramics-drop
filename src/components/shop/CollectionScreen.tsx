/* ============================================================
   CollectionScreen — shop head + family switcher + gallery.
   Server component; titles/leads come from i18n in content phase.
   ============================================================ */
import { Link } from '@/i18n/navigation';
import { CATEGORY_ORDER, getProductsByCategory } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';
import { Gallery } from './Gallery';

export function CollectionScreen({ slug }: { slug: CategorySlug }) {
  const products = getProductsByCategory(slug);

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow" />
            {/* TODO (content): family title (with italic Nº range) + lead */}
            <h1>{slug}</h1>
          </div>
          <div className="shop-switch">
            {CATEGORY_ORDER.map((s) => (
              <Link key={s} href={`/${s}`} className={s === slug ? 'active' : undefined}>
                {/* TODO (content): localized family name */}
                {s}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <Gallery products={products} />
    </>
  );
}
