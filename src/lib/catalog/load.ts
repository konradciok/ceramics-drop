/* ============================================================
   Catalog loaders — cached DB reads used by the storefront accessors
   ------------------------------------------------------------
   Thin cached wrappers over the repository readers, returning the exact
   `Product[]` / `PrintDesign[]` shapes the registry produces. Cached under the
   `catalog` tag so admin catalog writes can revalidate it via
   `revalidateTag('catalog', 'max')` (match the `inventory` / webhook pattern).

   Production runs CATALOG_SOURCE=db, so getProducts()/getPrintDesigns()/… and
   the other public accessors call these loaders at runtime (dynamic import from
   src/lib/products.ts + src/lib/prints.ts). Under CATALOG_SOURCE=code the
   accessors skip these and return the static registry instead.
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
