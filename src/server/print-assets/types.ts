/**
 * Row types for the print-asset fulfilment tables (migration
 * `20260711120000_print_fulfilment_assets.sql`). Mirrors the table shapes the
 * repository reads; the column set of `PrintFulfilmentAssetRow` is the full row
 * so other layers (Phase 4 signed route) can reuse it without re-querying.
 */

/** A row of `print_fulfilment_assets`. */
export interface PrintFulfilmentAssetRow {
  id: string;
  product_id: string;
  revision: string;
  profile_key: string | null;
  r2_key: string;
  sha256: string;
  content_type: 'image/jpeg' | 'image/png';
  width_px: number;
  height_px: number;
  byte_size: number;
  status: 'staged' | 'ready' | 'retired' | 'revoked';
  created_at: string;
  verified_at: string | null;
}

/** A row of `print_variant_asset_assignments`. */
export interface PrintVariantAssetAssignmentRow {
  product_id: string;
  variant_key: string;
  asset_id: string;
  created_at: string;
}

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
