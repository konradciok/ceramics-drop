/* ============================================================
   Catalog source flag
   ------------------------------------------------------------
   Selects where the storefront product accessors read from:
     - 'db':             the catalog shadow tables (PRODUCTION — wrangler.jsonc
                         sets CATALOG_SOURCE=db; accessors read Supabase at runtime)
     - 'code' (default): the static registry (src/lib/products.ts, prints.ts) —
                         the local/test fallback when the env var is unset

   The public accessors (getProducts/getProductsByCategory/getProductById/
   getPublicProducts/resolveCartProducts, plus the print equivalents) delegate to
   the 'db' path via src/lib/catalog/load.ts when this returns 'db'.
   ============================================================ */

export type CatalogSource = 'code' | 'db';

/**
 * Resolve the catalog source from the CATALOG_SOURCE env var. Anything other
 * than the exact string 'db' means 'code', so the safe default (registry) holds
 * unless the flag is deliberately set.
 */
export function catalogSource(): CatalogSource {
  return process.env.CATALOG_SOURCE === 'db' ? 'db' : 'code';
}
