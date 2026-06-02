/* ============================================================
   Domain types — Anna Ciok Ceramics
   Each piece is one-of-a-kind (a 1/1 edition), so the cart is a
   set of product IDs rather than line items with quantities.
   ============================================================ */

/** URL slug for each product family (also the collection route). */
export type CategorySlug =
  | 'kubki'
  | 'wazony'
  | 'wazony-duze'
  | 'talerzyki'
  | 'talerze-duze'
  | 'duze-michy'
  | 'miski-falowane';

/** A single one-of-a-kind ceramic piece. */
export interface Product {
  /** Stable id, e.g. `k01`. */
  id: string;
  category: CategorySlug;
  /** Display number within the family, e.g. `01`. */
  num: string;
  /** Public image path, e.g. `/uploads/kubek-1.webp`. */
  image: string;
  /** Price in EUR. */
  price: number;
  /** Physical measurement, e.g. `9 × 9 cm · 300 ml`. */
  measure: string;
  /** Whether the piece has already sold (1/1 → removed from sale). */
  sold: boolean;
  /** 0-based index into the category's `notes` array (description lookup). */
  noteIndex: number;
}

/** Structural metadata for a product family / collection page. */
export interface Category {
  slug: CategorySlug;
  /** i18n key for the family name. */
  nameKey: string;
  /** i18n key for the singular product name (e.g. `mug`). */
  singularKey: string;
  /** Flat price shared by every piece in the family (EUR). */
  price: number;
  /** Shared measurement string. */
  measure: string;
  /** Number of pieces in the family. */
  count: number;
}
