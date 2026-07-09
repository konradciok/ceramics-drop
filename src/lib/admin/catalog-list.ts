/* ============================================================
   Admin product list — catalogue ⨝ piece_state
   ------------------------------------------------------------
   Assembles the rows for the read-only /admin/products list by joining the
   catalogue (DB shadow tables, with the code registry as fallback until the
   backfill runs) with live piece_state. The assembly is pure and testable;
   only listProducts() touches IO.

   Stage 1: read-only. No mutations, no public-visibility effect.
   ============================================================ */
import { adminSupabase } from '@/lib/admin/clients';
import { listInventory, type Piece } from '@/lib/admin/data';
import { CATEGORY_LABEL, productRef } from '@/lib/admin/products';
import { buildCatalogSeed } from '@/lib/catalog/seed';
import { listCatalogRows, type CatalogRows } from '@/lib/catalog/repository';
import { resolveProductStatus, isDisplayStatusPurchasable, type ProductDisplayStatus } from '@/lib/catalog/status';
import { CATEGORY_ORDER, isCategoryHidden } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';

export interface ProductListRow {
  id: string;
  type: 'ceramic' | 'print';
  category: CategorySlug;
  categoryLabel: string;
  num: string;
  title: string;
  image: string | null;
  status: ProductDisplayStatus;
  purchasable: boolean;
  variantCount: number;
  /** '1/1' | '0/1' for ceramics, 'POD' for prints. */
  stockLabel: string;
  priceLabel: string;
}

export interface ProductListResult {
  rows: ProductListRow[];
  /** Where the catalogue came from — 'registry' means backfill hasn't run yet. */
  source: 'db' | 'registry';
}

const zl = (n: number | null): string => (n == null ? '—' : `${n} zł`);

function categoryRank(slug: CategorySlug): number {
  const i = CATEGORY_ORDER.indexOf(slug);
  return i === -1 ? CATEGORY_ORDER.length : i; // fine-art-prints (not in order) sorts last
}

/**
 * Pure assembly: catalogue rows + a piece_state lookup → display rows, sorted by
 * category then display number. Ceramics carry their 1/1 piece_state; prints are
 * POD (no piece row, always in stock per variant).
 */
export function assembleProductRows(catalog: CatalogRows, pieceById: Map<string, Piece>): ProductListRow[] {
  const variantsByProduct = new Map<string, CatalogRows['variants']>();
  for (const v of catalog.variants) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  const rows: ProductListRow[] = catalog.products.map((p) => {
    const variants = variantsByProduct.get(p.id) ?? [];
    const piece = pieceById.get(p.id) ?? null;
    const ref = productRef(p.id);

    // Sellable stock: a tracked variant needs qty > 0; POD (untracked) is always in stock.
    const hasStock = variants.length === 0
      ? true
      : variants.some((v) => (v.track_inventory ? v.stock_quantity > 0 : true));

    const status = resolveProductStatus({
      catalogStatus: p.status,
      categoryHidden: isCategoryHidden(p.category_slug),
      piece: piece ? { status: piece.status, reservedExpired: piece.reservedExpired } : null,
      hasStock,
    });

    const priceLabel = p.type === 'print'
      ? (() => {
          const prices = variants.map((v) => v.price_pln).filter((n): n is number => n != null);
          return prices.length ? `od ${Math.min(...prices)} zł` : '—';
        })()
      : zl(p.price_pln);

    const stockLabel = p.type === 'print'
      ? 'POD'
      : piece?.status === 'sold'
        ? '0/1'
        : '1/1';

    return {
      id: p.id,
      type: p.type,
      category: p.category_slug,
      categoryLabel: CATEGORY_LABEL[p.category_slug] ?? p.category_slug,
      num: p.num,
      title: ref.label,
      image: ref.image,
      status,
      purchasable: isDisplayStatusPurchasable(status),
      variantCount: variants.length,
      stockLabel,
      priceLabel,
    };
  });

  rows.sort((a, b) => {
    const byCat = categoryRank(a.category) - categoryRank(b.category);
    return byCat !== 0 ? byCat : a.num.localeCompare(b.num);
  });
  return rows;
}

/**
 * Read the admin product list. Prefers the DB catalogue; when the shadow tables
 * are empty (backfill not run yet) it falls back to the code registry — which is
 * byte-for-byte the seed the backfill would insert, so the list is identical.
 */
export async function listProducts(): Promise<ProductListResult> {
  const supabase = adminSupabase();
  const [pieces, dbRows] = await Promise.all([listInventory(), listCatalogRows(supabase)]);
  const source: 'db' | 'registry' = dbRows.products.length > 0 ? 'db' : 'registry';
  const catalog: CatalogRows = source === 'db'
    ? dbRows
    : (() => {
        const seed = buildCatalogSeed();
        return { products: seed.products, variants: seed.variants };
      })();
  const pieceById = new Map(pieces.map((p) => [p.product_id, p]));
  return { rows: assembleProductRows(catalog, pieceById), source };
}
