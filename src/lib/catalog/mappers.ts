/* ============================================================
   Catalog mappers — DB rows → domain shapes
   ------------------------------------------------------------
   Reconstruct the `Product` shape the storefront already consumes from
   catalog table rows. Kept pure so the parity test can round-trip
   `buildCatalogSeed()` back to `getProducts()` without a live DB, and so the
   eventual storefront flip (Stage 3) reuses the exact same reconstruction.
   ============================================================ */
import type { Product } from '../types';
import type { MediaSeedRow, ProductSeedRow } from './types';

/** Group media rows by product id, each list sorted by `position`. */
function mediaByProduct(media: MediaSeedRow[]): Map<string, MediaSeedRow[]> {
  const byId = new Map<string, MediaSeedRow[]>();
  for (const m of media) {
    const list = byId.get(m.product_id) ?? [];
    list.push(m);
    byId.set(m.product_id, list);
  }
  for (const list of byId.values()) list.sort((a, b) => a.position - b.position);
  return byId;
}

/**
 * Reconstruct the ceramic `Product[]` from catalog rows, preserving input order
 * (the seed and the live read both order by category then display num). The
 * primary image and gallery come from `product_media`; `sold`/`showroom` are NOT
 * set here — they stay a runtime overlay from `piece_state`, exactly as today.
 */
export function mapCeramicProducts(products: ProductSeedRow[], media: MediaSeedRow[]): Product[] {
  const byProduct = mediaByProduct(media);
  const out: Product[] = [];

  for (const row of products) {
    if (row.type !== 'ceramic') continue;
    const imgs = byProduct.get(row.id) ?? [];
    const primary = imgs.find((m) => m.is_primary) ?? imgs[0];
    const gallery = imgs.filter((m) => !m.is_primary).map((m) => m.url);

    out.push({
      id: row.id,
      category: row.category_slug,
      num: row.num,
      image: primary?.url ?? '',
      ...(gallery.length ? { gallery } : {}),
      price: row.price_pln ?? 0,
      measure: row.measure,
      sold: false,
      dropId: row.drop_id ?? '',
      noteIndex: row.note_index ?? 0,
    });
  }

  return out;
}
