/* ============================================================
   Product display status — one unified, computed status
   ------------------------------------------------------------
   Collapses the axes that today live in separate places (catalogue
   presence, HIDDEN_CATEGORIES, print `published`, piece_state sold/reserved,
   stock) into a single status the admin list shows. Pure and dependency-free
   so it is trivially testable and reusable by later stages.

   NOTE (Stage 1): this is DISPLAY-ONLY. It does not yet drive any public
   visibility fan-out — the storefront still reads the code registry. Stage 3
   is where the flip happens.
   ============================================================ */
import type { ProductStatus } from './types';

/** The status shown per product in the admin list. */
export type ProductDisplayStatus =
  | 'archived'
  | 'draft'
  | 'hidden'
  | 'sold'
  | 'showroom'
  | 'reserved'
  | 'out_of_stock'
  | 'active';

/** Minimal piece_state shape (ceramics only; prints/POD have no piece row). */
export interface StatusPieceInput {
  status: 'available' | 'reserved' | 'sold';
  /** reserved but the hold has lapsed → effectively available again. */
  reservedExpired: boolean;
  /** Retired into the showroom: visible, no longer purchasable. */
  showroom: boolean;
}

export interface StatusInput {
  /** The catalogue `status` column (draft | active | hidden | archived). */
  catalogStatus: ProductStatus;
  /** Whether the product's category is withdrawn from the public storefront. */
  categoryHidden: boolean;
  /** The ceramic piece_state row, if any (undefined/null for prints / POD). */
  piece?: StatusPieceInput | null;
  /** Whether any sellable stock exists (ceramic: qty > 0; print/POD: always true). */
  hasStock: boolean;
}

/**
 * Resolve the single display status. Catalogue-level states (archived, draft,
 * hidden) take precedence over stock/sale state, because a draft or archived
 * product is not on sale regardless of its inventory. For an otherwise-active
 * product the piece_state / stock overlay decides: sold → showroom → reserved
 * (live hold) → out_of_stock → active. Showroom mirrors production
 * `isProductPurchasable` (a showroom piece is visible but not buyable); it sits
 * after `sold` so a sold piece retired into the showroom still reads as sold.
 */
export function resolveProductStatus(input: StatusInput): ProductDisplayStatus {
  const { catalogStatus, categoryHidden, piece, hasStock } = input;

  if (catalogStatus === 'archived') return 'archived';
  if (catalogStatus === 'draft') return 'draft';
  if (catalogStatus === 'hidden' || categoryHidden) return 'hidden';

  // catalogStatus === 'active' below.
  if (piece?.status === 'sold') return 'sold';
  if (piece?.showroom) return 'showroom';
  if (piece?.status === 'reserved' && !piece.reservedExpired) return 'reserved';
  if (!hasStock) return 'out_of_stock';
  return 'active';
}

/** Whether a product in this status is publicly purchasable right now. */
export function isDisplayStatusPurchasable(status: ProductDisplayStatus): boolean {
  return status === 'active';
}
