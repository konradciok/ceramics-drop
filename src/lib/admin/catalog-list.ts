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
import { listCatalogRows, readProductRow, type CatalogRows } from '@/lib/catalog/repository';
import { resolveProductStatus, isDisplayStatusPurchasable, type ProductDisplayStatus } from '@/lib/catalog/status';
import { CATEGORY_ORDER, isCategoryHidden } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';
import type { ProductSeedRow } from '@/lib/catalog/types';
import { getPrintAssetCoverage } from '@/server/print-assets/repository';
import type { PrintAssetCoverage } from '@/server/print-assets/types';

/** Print asset coverage load result for the product editor (prints in db mode only). */
export type ProductPrintAssetsState =
  | { status: 'na' }
  | { status: 'ok'; coverage: PrintAssetCoverage }
  | { status: 'error' };

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
  /** Numeric PLN for sorting, decoupled from the display label. Infinity when unpriced. */
  priceValue: number;
}

export interface ProductListResult {
  rows: ProductListRow[];
  /** Where the catalogue came from — 'registry' means backfill hasn't run (or is incomplete). */
  source: 'db' | 'registry';
  /** DB catalogue product count (0 when un-backfilled). */
  dbCount: number;
  /** Products the backfill would insert from the registry. */
  expectedCount: number;
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

    // Sellable stock: an ACTIVE variant that is either untracked (POD) or has qty > 0.
    // A product with NO variants is unknown-stock (e.g. a partial backfill) → not
    // sellable, so it never falsely counts as active/purchasable.
    const hasStock =
      variants.length > 0 &&
      variants.some((v) => v.active && (v.track_inventory ? v.stock_quantity > 0 : true));

    const status = resolveProductStatus({
      catalogStatus: p.status,
      categoryHidden: isCategoryHidden(p.category_slug),
      piece: piece
        ? { status: piece.status, reservedExpired: piece.reservedExpired, showroom: piece.showroom }
        : null,
      hasStock,
    });

    const printPrices = p.type === 'print'
      ? variants.map((v) => v.price_pln).filter((n): n is number => n != null)
      : [];
    const priceValue = p.type === 'print'
      ? (printPrices.length ? Math.min(...printPrices) : Number.POSITIVE_INFINITY)
      : (p.price_pln ?? Number.POSITIVE_INFINITY);
    const priceLabel = p.type === 'print'
      ? (printPrices.length ? `od ${Math.min(...printPrices)} zł` : '—')
      : zl(p.price_pln);

    // Reconcile the Magazyn column with purchasability (not just the raw sold flag),
    // so it never contradicts the status pill next to it.
    const stockLabel = p.type === 'print'
      ? 'POD'
      : status === 'active'
        ? '1/1'
        : status === 'reserved'
          ? '1/1 · hold'
          : '0/1';

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
      priceValue,
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
  // A transient DB failure on the catalogue read must not take down the page —
  // fall back to the registry (same path as an un-backfilled DB).
  const [pieces, dbRows] = await Promise.all([
    listInventory(),
    listCatalogRows(supabase).catch((err) => {
      // Log so a persistent DB failure is distinguishable from an un-backfilled DB
      // (both otherwise render the same registry-fallback banner).
      console.error('[admin/products] listCatalogRows failed, falling back to registry', err);
      return { products: [], variants: [] } as CatalogRows;
    }),
  ]);
  const seed = buildCatalogSeed();
  const registry: CatalogRows = { products: seed.products, variants: seed.variants };

  // Only trust the DB catalogue once it is COMPLETE. A partial/interrupted backfill
  // (or a registry that grew since the last sync) would otherwise silently drop
  // products from the list — so fall back to the registry and let the page warn.
  const complete = dbRows.products.length >= registry.products.length;
  const source: 'db' | 'registry' = dbRows.products.length > 0 && complete ? 'db' : 'registry';
  const catalog = source === 'db' ? dbRows : registry;

  const pieceById = new Map(pieces.map((p) => [p.product_id, p]));
  return {
    rows: assembleProductRows(catalog, pieceById),
    source,
    dbCount: dbRows.products.length,
    expectedCount: registry.products.length,
  };
}

export interface ProductEditorState {
  row: ProductSeedRow;
  title: string;
  image: string | null;
  categoryLabel: string;
  /** 'registry' = the DB row is missing (backfill not run) — saves will 404 until it is. */
  source: 'db' | 'registry';
  /** id-based PDP path for the "view on site" link (PL default locale). */
  pdpPath: string;
  /** Deep link to the category's description document in the Content module. */
  notesHref: string;
  /** Print fulfilment asset coverage (prints in db mode; na for ceramics/registry). */
  printAssets: ProductPrintAssetsState;
}

/**
 * Load one product for the `/admin/products/[id]` editor. Prefers the DB row;
 * falls back to the registry seed row (so the page still renders before the
 * backfill, though saving will 404 until the row exists in the DB).
 */
export async function getProductEditorState(id: string): Promise<ProductEditorState | null> {
  const supabase = adminSupabase();
  const dbRow = await readProductRow(supabase, id).catch((err) => {
    console.error('[admin/products] readProductRow failed, falling back to registry seed', err);
    return null;
  });

  let row = dbRow?.product ?? null;
  const source: 'db' | 'registry' = dbRow ? 'db' : 'registry';
  if (!row) {
    row = buildCatalogSeed().products.find((p) => p.id === id) ?? null;
  }
  if (!row) return null;

  const ref = productRef(id);
  let printAssets: ProductPrintAssetsState = { status: 'na' };
  if (row.type === 'print' && source === 'db') {
    try {
      const coverage = await getPrintAssetCoverage(id);
      printAssets = { status: 'ok', coverage };
    } catch (err) {
      console.error('[admin/products] getPrintAssetCoverage failed', err);
      printAssets = { status: 'error' };
    }
  }

  return {
    row,
    title: ref.label,
    image: ref.image,
    categoryLabel: CATEGORY_LABEL[row.category_slug] ?? row.category_slug,
    source,
    pdpPath: `/${row.category_slug}/${row.id}`,
    notesHref: `/admin/content/product_notes/${row.category_slug}`,
    printAssets,
  };
}
