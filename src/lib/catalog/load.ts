/* ============================================================
   Catalog loaders — cached DB reads for the storefront flip
   ------------------------------------------------------------
   Thin cached wrappers over the repository readers, returning the exact
   `Product[]` / `PrintDesign[]` shapes the registry produces. Cached under the
   `catalog` tag so admin catalog writes (Stage 4) can revalidate it via
   `revalidateTag('catalog', 'max')` (match the `inventory` / webhook pattern).

   Stage 3a ships these but does NOT wire them into the storefront accessors —
   that async cutover is Stage 3b, gated behind CATALOG_SOURCE=db.
   ============================================================ */
import { unstable_cache } from 'next/cache';
import type { PrintDesign, Product } from '../types';
import { getSupabaseAdmin } from '../supabase';
import { readCeramicProducts, readPrintDesigns } from './repository';

const CATALOG_TAG = 'catalog';
const REVALIDATE_SECONDS = 300;

/** Ceramic products from the DB catalogue (cached). */
export const loadCeramicProductsFromDb: () => Promise<Product[]> = unstable_cache(
  async () => readCeramicProducts(getSupabaseAdmin()),
  ['catalog-ceramic-products'],
  { tags: [CATALOG_TAG], revalidate: REVALIDATE_SECONDS },
);

/** Print designs from the DB catalogue (cached; includes drafts). */
export const loadPrintDesignsFromDb: () => Promise<PrintDesign[]> = unstable_cache(
  async () => readPrintDesigns(getSupabaseAdmin()),
  ['catalog-print-designs'],
  { tags: [CATALOG_TAG], revalidate: REVALIDATE_SECONDS },
);
