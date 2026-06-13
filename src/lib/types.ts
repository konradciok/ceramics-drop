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
  // Fine-art prints — reproducible, configurable (size × paper × frame), NOT 1/1.
  // Deliberately kept OUT of CATEGORY_ORDER: prints live in a separate registry
  // (src/lib/prints.ts) so the one-of-a-kind ceramic machinery is untouched.
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

/* ============================================================
   Fine-art prints — a configurable design (size × paper × frame).
   Unlike `Product` (a 1/1 piece), a print is reproducible: the same
   design sells in many variant combinations, each with its own price
   and SKU. Kept as a SEPARATE type (not a discriminated union over
   `Product`) to contain the blast radius to print-specific code.
   ============================================================ */

/** Print size axis. Placeholder values — confirm with the studio. */
export type PrintSize = 'a4' | 'a3' | 'a2';
/** Paper axis. Placeholder values — confirm with the studio. */
export type PrintPaper = 'matte' | 'satin';
/** Frame axis. Placeholder values — confirm with the studio. */
export type PrintFrame = 'none' | 'oak' | 'black';

/** A single resolved variant choice across the three axes. */
export interface PrintVariantSelection {
  size: PrintSize;
  paper: PrintPaper;
  frame: PrintFrame;
}

/** A fine-art print design (reproducible, configurable). */
export interface PrintDesign {
  /** Stable id, prefix `fap`, e.g. `fap01`. */
  id: string;
  category: 'fine-art-prints';
  /** Display number within the family, e.g. `01`. */
  num: string;
  /** Primary image (the artwork reproduction). */
  image: string;
  /** Room mockups, paper/frame close-ups. */
  gallery?: string[];
  /** 0-based index into notes['fine-art-prints'][] (description lookup). */
  noteIndex: number;
  /** Axes offered for THIS design (a subset of the global axes may be disabled). */
  sizes: PrintSize[];
  papers: PrintPaper[];
  frames: PrintFrame[];
  /** Excluded combinations, keyed by `${size}:${paper}:${frame}` (variantKey). */
  unavailable?: string[];
  /** Published designs are sellable; false hides the design entirely. */
  published: boolean;
  /** Display-only "from" price in PLN (listing / sorting / SEO). */
  fromPLN: number;
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
