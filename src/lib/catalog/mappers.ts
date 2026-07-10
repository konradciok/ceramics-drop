/* ============================================================
   Catalog mappers — DB rows → domain shapes
   ------------------------------------------------------------
   Reconstruct the `Product` shape the storefront already consumes from
   catalog table rows. Kept pure so the parity test can round-trip
   `buildCatalogSeed()` back to `getProducts()` without a live DB, and so the
   eventual storefront flip (Stage 3) reuses the exact same reconstruction.
   ============================================================ */
import { CATEGORY_ORDER } from '../products';
import type { CategorySlug, PrintDesign, PrintFrameColour, PrintSize, Product } from '../types';
import type { MediaSeedRow, ProductSeedRow, VariantSeedRow } from './types';

function ceramicCategoryRank(slug: CategorySlug): number {
  const i = CATEGORY_ORDER.indexOf(slug);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/** Order ceramic product rows by CATEGORY_ORDER then display num (not alphabetical slug). */
export function sortCeramicProductRows(products: ProductSeedRow[]): ProductSeedRow[] {
  return [...products].sort((a, b) => {
    const byCat = ceramicCategoryRank(a.category_slug) - ceramicCategoryRank(b.category_slug);
    if (byCat !== 0) return byCat;
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
      price: row.price_pln ?? 0,
      measure: row.measure,
      sold: false,
      dropId: row.drop_id ?? '',
      noteIndex: row.note_index ?? 0,
    });
  }

  return out;
}

/** Distinct values in first-seen order (variants are read in `position` order). */
function distinctInOrder<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Reconstruct `PrintDesign[]` from catalog rows — the inverse of `printRows`
 * in seed.ts. Axes (size / frame colour / mount) are recovered from the variant
 * rows in `position` order; `published` comes from the product status; media
 * gives image + gallery. Inactive variants are excluded from axis recovery on
 * published designs only (drafts seed every variant inactive).
 *
 * NOTE (Stage 3a): `unavailable` and per-size `prices` overrides are NOT stored
 * as such in the shadow tables (variants are the flattened form), so they are
 * left unset here. The current registry designs (fap01–fap04) use neither, so
 * the round-trip is exact for today's data; proper storage of those fields lands
 * with print CRUD (Stage 5). `variants`/`media` must be passed in `position` order.
 */
export function mapPrintDesigns(
  products: ProductSeedRow[],
  variants: VariantSeedRow[],
  media: MediaSeedRow[],
): PrintDesign[] {
  const mediaFor = mediaByProduct(media);
  const variantsFor = new Map<string, VariantSeedRow[]>();
  for (const v of variants) {
    const list = variantsFor.get(v.product_id) ?? [];
    list.push(v);
    variantsFor.set(v.product_id, list);
  }
  for (const list of variantsFor.values()) list.sort((a, b) => a.position - b.position);

  const out: PrintDesign[] = [];
  for (const row of products) {
    if (row.type !== 'print') continue;
    const allVs = variantsFor.get(row.id) ?? [];
    // Published designs: honour per-variant deactivation. Drafts seed all variants
    // inactive, so axis recovery must still read them to match the registry.
    const vs = row.status === 'active' ? allVs.filter((v) => v.active) : allVs;
    const axes = vs.map((v) => v.axes).filter((a): a is NonNullable<VariantSeedRow['axes']> => a !== null);
    const imgs = mediaFor.get(row.id) ?? [];
    const primary = imgs.find((m) => m.is_primary) ?? imgs[0];
    const gallery = imgs.filter((m) => !m.is_primary).map((m) => m.url);

    const sizes = distinctInOrder(axes.map((a) => a.size)) as PrintSize[];
    const frameColours = distinctInOrder(
      axes.filter((a) => a.framed && a.frameColour !== 'none').map((a) => a.frameColour),
    ) as PrintFrameColour[];
    const mountAvailable = axes.some((a) => a.mount);

    out.push({
      id: row.id,
      category: 'fine-art-prints',
      num: row.num,
      image: primary?.url ?? '',
      ...(gallery.length ? { gallery } : {}),
      noteIndex: row.note_index ?? 0,
      sizes,
      frameColours,
      mountAvailable,
      published: row.status === 'active',
    });
  }

  return out;
}
