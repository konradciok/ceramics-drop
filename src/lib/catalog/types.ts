/* ============================================================
   Catalog data layer — DB row shapes
   ------------------------------------------------------------
   Row shapes for the `products` / `product_variants` / `product_media`
   tables (migration 20260709140000_catalog_shadow.sql). These mirror the
   static code registry during the strangler migration; the storefront
   accessors read them at runtime under CATALOG_SOURCE=db (production).
   ============================================================ */
import type { CategorySlug, PrintVariantSelection } from '../types';

export type ProductType = 'ceramic' | 'print';
export type ProductStatus = 'draft' | 'active' | 'hidden' | 'archived';

/** A row of the `products` table (backfill/insert shape — DB-managed columns omitted). */
export interface ProductSeedRow {
  id: string;
  type: ProductType;
  category_slug: CategorySlug;
  num: string;
  slug: string | null;
  price_pln: number | null;
  price_eur: number | null;
  price_gbp: number | null;
  sale_price_pln: number | null;
  sale_price_eur: number | null;
  sale_price_gbp: number | null;
  measure: string;
  status: ProductStatus;
  seo_title: string | null;
  seo_description: string | null;
  drop_id: string | null;
  note_index: number | null;
}

/** A row of the `product_variants` table (backfill/insert shape). */
export interface VariantSeedRow {
  product_id: string;
  variant_key: string;
  sku: string | null;
  axes: PrintVariantSelection | null;
  price_pln: number | null;
  price_eur: number | null;
  price_gbp: number | null;
  is_default: boolean;
  active: boolean;
  position: number;
  track_inventory: boolean;
  stock_quantity: number;
  allow_backorder: boolean;
  low_stock_threshold: number | null;
  // Per-variant print-area pixel contract (300 DPI) the publish_print_asset_revision
  // RPC checks ready assets against. Seeded from PRODIGI_SKU_MAP[variant_key].printAreaPx
  // for prints; null for ceramics. Fulfilment metadata only — no counterpart in the
  // registry Product/PrintDesign types, so the mapper never surfaces it.
  print_area_width_px: number | null;
  print_area_height_px: number | null;
}

/** A row of the `product_media` table (backfill/insert shape). */
export interface MediaSeedRow {
  product_id: string;
  url: string;
  alt: string | null;
  position: number;
  is_primary: boolean;
}

/** The full backfill payload produced from the code registry. */
export interface CatalogSeed {
  products: ProductSeedRow[];
  variants: VariantSeedRow[];
  media: MediaSeedRow[];
}
