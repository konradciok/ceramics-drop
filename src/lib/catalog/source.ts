/* ============================================================
   Catalog source flag
   ------------------------------------------------------------
   Selects where the storefront product accessors read from:
     - 'code' (default): the static registry (src/lib/products.ts, prints.ts)
     - 'db':             the catalog shadow tables (Stage 3b flip)

   Stage 3a only ships this flag + the DB read path; it is NOT yet wired into
   the storefront accessors. The flip (making getProducts()/… delegate here) and
   turning `db` on in production are separate, gated steps.
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
