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
  /**
   * Runtime-merged from `piece_state.showroom`: the piece is retired into the
   * showroom (still visible, no longer purchasable). Defaults to undefined
   * (not in showroom); overlaid at render time exactly like `sold`.
   */
  showroom?: boolean;
  /** Which sales-event drop this piece was released in. References `drops.id`. */
  dropId: string;
  /** 0-based index into the category's `notes` array (description lookup). */
  noteIndex: number;
  /**
   * Catalog publish status from the DB `products.status` column, surfaced only
   * in CATALOG_SOURCE=db mode. The code registry leaves it undefined, which is
   * treated as `'active'` everywhere — so `code` mode is unaffected. Drives
   * per-product public visibility (see `isProductPublic` / `isProductPurchasable`
   * in products.ts); distinct from the runtime `sold` / `showroom` overlays,
   * which still render (sold pieces show a badge) whereas a non-active status
   * withdraws the product entirely.
   */
  status?: 'draft' | 'active' | 'hidden' | 'archived';
  /**
   * SEO overrides from the DB (`products.seo_title` / `seo_description`),
   * surfaced only in db mode when set (undefined in the code registry). When
   * present they take precedence in the PDP `generateMetadata`; otherwise the
   * derived title / CMS note are used.
   */
  seoTitle?: string;
  seoDescription?: string;
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
export type PrintFrameColour = 'black' | 'natural' | 'brown';

/** A single resolved variant choice. mount is only meaningful when framed=true. */
export interface PrintVariantSelection {
  size: PrintSize;
  framed: boolean;
  mount: boolean;
  frameColour: PrintFrameColour | 'none'; // 'none' when framed=false
}

/** A fine-art print design (open edition, configurable). */
export interface PrintDesign {
  id: string;                        // e.g. 'fap001'
  category: 'fine-art-prints';
  num: string;                       // active display number, two digits, e.g. '01'
  image: string;
  gallery?: string[];
  /** PDP-only static slides shown after the configurator hero — deliberately
      excluded from merchant feeds (buildPrintFeedItems reads only `gallery`)
      because these are lifestyle/staging shots, not the product itself. Not
      surfaced by collection cards, the "more from this collection" strip, or
      /gallery. Ship the 3 generated WebPs in the same PR as this field
      (print-assets:editorial). */
  editorialGallery?: string[];
  noteIndex: number;
  sizes: PrintSize[];
  frameColours: PrintFrameColour[];  // colours offered; empty means unframed-only
  mountAvailable: boolean;
  unavailable?: string[];            // variantKey strings to exclude
  published: boolean;
  /** Set when pre-rendered configurator mockups exist in public/uploads
      (<image-stem>-mock-{framed|mount}-{colour}.webp). Ship the flag in the
      same PR as the generated files (print-assets:mockups). */
  mockups?: true;
}
