/* ============================================================
   Catalog mappers — DB rows → domain shapes
   ------------------------------------------------------------
   Reconstruct the `Product` shape the storefront already consumes from
   catalog table rows. Kept pure so the parity test can round-trip
   `buildCatalogSeed()` back to `getProducts()` without a live DB, and so the
   eventual storefront flip (Stage 3) reuses the exact same reconstruction.
   ============================================================ */
import { CATEGORY_ORDER, DEFAULT_DROP_ID } from '../products';
import type { CategorySlug, Product } from '../types';
import type { MediaSeedRow, ProductSeedRow } from './types';

function ceramicCategoryRank(slug: CategorySlug): number {
  const i = CATEGORY_ORDER.indexOf(slug);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Order ceramic product rows by CATEGORY_ORDER, then by family position
 * (`note_index`), then display num (not alphabetical slug). The display num
 * restarts at 01 in every drop, so it cannot order a family on its own — a
 * later drop's Nº 03 would land between the earlier drop's 03 and 04.
 * `note_index` is the registry's positional index across the whole family;
 * rows without one (CMS-authored) follow, ordered by num.
 */
export function sortCeramicProductRows(products: ProductSeedRow[]): ProductSeedRow[] {
  return [...products].sort((a, b) => {
    const byCat = ceramicCategoryRank(a.category_slug) - ceramicCategoryRank(b.category_slug);
    if (byCat !== 0) return byCat;
    const ai = a.note_index ?? Number.POSITIVE_INFINITY;
    const bi = b.note_index ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.num.localeCompare(b.num, undefined, { numeric: true });
  });
}

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
      // INVARIANT: every production caller (readCeramicProducts in
      // repository.ts) filters rows through read-schemas.ts's
      // parseProductRow(s) before calling this mapper, which enforces
      // price_pln > 0 for every ceramic row — so it is runtime-guaranteed
      // non-null here. Deliberately NOT `row.price_pln ?? 0`: a fallback to 0
      // would let a future caller that skips the guard silently sell a piece
      // at 0 zł (the exact bug this guard exists to prevent, M-4) instead of
      // failing loudly with a visibly broken price.
      price: row.price_pln!,
      measure: row.measure,
      sold: false,
      // NULL membership (pre-default rows) stays in the original drop rather than vanishing.
      dropId: row.drop_id ?? DEFAULT_DROP_ID,
      noteIndex: row.note_index ?? 0,
      // Surface `status` ONLY when it is not the default 'active', so an active
      // ceramic stays byte-identical to the code registry (which carries no
      // status field) and the parity tests keep round-tripping. A non-active
      // status flows through to isProductPublic and withdraws the product.
      ...(row.status !== 'active' ? { status: row.status } : {}),
      // SEO overrides only when set (registry has none → parity preserved).
      ...(row.seo_title ? { seoTitle: row.seo_title } : {}),
      ...(row.seo_description ? { seoDescription: row.seo_description } : {}),
      // CMS-authored copy only when set (registry has none → parity preserved).
      ...(row.title ? { title: row.title } : {}),
      ...(row.description ? { description: row.description } : {}),
      // DB-backed EUR/GBP only when set (registry has none → parity preserved,
      // priceOfCurrency() falls back to the code constant). Unlike price_pln,
      // these are not runtime-guaranteed non-null, so `!= null` (not a bare
      // price_pln!-style assertion) — a registry-seeded row that predates the
      // first backfill run after this column existed could still be null.
      ...(row.price_eur != null ? { priceEur: row.price_eur } : {}),
      ...(row.price_gbp != null ? { priceGbp: row.price_gbp } : {}),
    });
  }

  return out;
}

