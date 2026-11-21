/* ============================================================
   Catalog loaders — direct DB reads used by the storefront accessors
   ------------------------------------------------------------
   Direct wrappers over the repository readers, returning the exact `Product[]`
   shape the registry produces. OpenNext is configured with a
   read-only static-assets incremental cache and a dummy tag cache, so wrapping
   these reads in unstable_cache would promise invalidation semantics the
   deployed runtime cannot provide. Every invocation therefore reads Supabase.

   Production runs CATALOG_SOURCE=db, so getProducts()/… and the other public
   accessors call these loaders at runtime (dynamic import from
   src/lib/products.ts). Under CATALOG_SOURCE=code the
   accessors skip these and return the static registry instead.
   ============================================================ */
import type { Product } from '../types';
import { getSupabaseAdmin } from '../supabase';
import { readCeramicProducts } from './repository';

/** Ceramic products from the DB catalogue (always fresh). */
export async function loadCeramicProductsFromDb(): Promise<Product[]> {
  return readCeramicProducts(getSupabaseAdmin());
}
