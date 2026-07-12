/**
 * Contract types returned by the print-asset repository (migration
 * `20260711120000_print_fulfilment_assets.sql`). These are the fixed shapes
 * Phase 3 (checkout snapshot) and Phase 5 (publish guard) consume — field names
 * are part of the contract, do not rename.
 */

/**
 * The checkout-time view of an asset usable for a NEW order. Field names are the
 * fixed contract Phase 3 (checkout snapshot) and Phase 5 consume — do not rename.
 */
export interface ResolvedPrintAsset {
  assetId: string; // print_fulfilment_assets.id (uuid)
  r2Key: string; // immutable R2 key
  sha256: string;
  contentType: 'image/jpeg' | 'image/png';
  widthPx: number;
  heightPx: number;
}

/**
 * Publish-guard + admin view of a product's asset coverage. `ready` is true iff
 * every active variant has a usable assignment; zero active variants is
 * vacuously ready.
 */
export interface PrintAssetReadiness {
  productId: string;
  ready: boolean;
  totalActiveVariants: number;
  /** active variant_keys with no usable assignment (sorted, stable) */
  missing: string[];
}

/** Per-variant fulfilment asset row for the admin product editor (read-only). */
export interface PrintAssetVariantCoverage {
  variantKey: string;
  printAreaWidthPx: number | null;
  printAreaHeightPx: number | null;
  usable: boolean;
  asset: {
    id: string;
    revision: string;
    widthPx: number;
    heightPx: number;
    status: string;
    verifiedAt: string | null;
  } | null;
}

/** Admin view: readiness summary plus per-variant assignment detail. */
export interface PrintAssetCoverage extends PrintAssetReadiness {
  variants: PrintAssetVariantCoverage[];
}
