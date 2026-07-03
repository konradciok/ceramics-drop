/* ============================================================
   Domain types — Anna Ciok Ceramics
   Each piece is one-of-a-kind (a 1/1 edition), so the cart is a
   set of product IDs rather than line items with quantities.
   ============================================================ */

/** URL slug for each product family (also the collection route). */
export type CategorySlug =
  | 'kubki'
  | 'wazony'
  | 'wazony-srednie'
  | 'wazony-duze'
  | 'talerzyki'
  | 'talerze-srednie'
  | 'talerze-duze'
  | 'duze-michy'
  | 'miski-falowane'
  | 'fine-art-prints';

/** A single one-of-a-kind ceramic piece. */
export interface Product {
  /** Stable id, e.g. `k01`. */
  id: string;
  category: CategorySlug;
  /** Display number within the family, e.g. `01`. */
  num: string;
  /** Public image path, e.g. `/uploads/kubek-1.webp`. */
  image: string;
  /** Additional images beyond the primary (gallery / second photos). */
  gallery?: string[];
  /** Price in PLN (złoty). */
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
  /** Flat price shared by every piece in the family (PLN). */
  price: number;
  /** Shared measurement string. */
  measure: string;
  /** Number of pieces in the family. */
  count: number;
}

// ── Fine-art prints ──────────────────────────────────────────────────────────

/** Display size labels (cm). Maps to Prodigi SKU suffix: 30x40→12X16, 50x70→20X28, 70x100→28X40. */
export type PrintSize = '30x40' | '50x70' | '70x100';

/** Frame colour offered in the store (3 of 8 Prodigi colours). */
export type PrintFrameColour = 'black' | 'white' | 'natural';

/** A single resolved variant choice. mount is only meaningful when framed=true. */
export interface PrintVariantSelection {
  size: PrintSize;
  framed: boolean;
  mount: boolean;
  frameColour: PrintFrameColour | 'none'; // 'none' when framed=false
}

/** A fine-art print design (open edition, configurable). */
export interface PrintDesign {
  id: string;                        // e.g. 'fap01'
  category: 'fine-art-prints';
  num: string;                       // display number, e.g. '01'
  image: string;
  gallery?: string[];
  noteIndex: number;
  sizes: PrintSize[];
  frameColours: PrintFrameColour[];  // colours offered; empty means unframed-only
  mountAvailable: boolean;
  unavailable?: string[];            // variantKey strings to exclude
  published: boolean;
  /** Per-size price overrides (major units) for premium designs; sizes not
      listed fall back to the shared SIZE_BASE in print-pricing.ts. */
  prices?: Partial<Record<PrintSize, { pln: number; eur: number; gbp: number }>>;
}
