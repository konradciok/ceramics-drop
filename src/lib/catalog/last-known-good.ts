/* ============================================================
   Ceramic catalog last-known-good — isolate-lifetime fallback tiers
   ------------------------------------------------------------
   loadCeramicCatalog() in products.ts consults this on every DB read:
   record the result on success, resolve a fallback value on failure. Two
   tiers:

     - 'last-known-good': the most recent successful DB read in this
       isolate. Real DB data, so `status` (draft/hidden/archived) carries
       through exactly — nothing that was withdrawn reappears, and
       sold/showroom pieces stay exactly as last observed.
     - 'cold-fail-closed': no successful DB read has happened yet in this
       isolate (a cold isolate hit by a DB outage on its very first catalog
       read). There is no real data to fall back to, so every registry
       product is projected as non-public (status forced to 'hidden')
       rather than defaulting to 'active' the way the bare registry does —
       see SEO-003.

   Module-scope, in-process only — no Cloudflare binding, no persistence
   promise across isolates/deploys. Distinct from the `unstable_cache`
   restriction in AGENTS.md, which is about the primary DB read path
   claiming a durable invalidation guarantee it can't back up; this is
   just the freshest value one isolate happens to be holding.
   ============================================================ */
import type { CategorySlug, Product } from '../types';
import type { CeramicCatalog } from '../products';

export type FallbackTier = 'last-known-good' | 'cold-fail-closed';

let lastGood: CeramicCatalog | null = null;

/** Record the result of a successful DB read as this isolate's last-known-good. */
export function recordCeramicCatalogSuccess(catalog: CeramicCatalog): void {
  lastGood = catalog;
}

/** Test-only: clear the isolate's last-known-good state between cases. */
export function resetLastKnownGoodForTests(): void {
  lastGood = null;
}

function groupByCategory(products: Product[]): Record<CategorySlug, Product[]> {
  const acc = {} as Record<CategorySlug, Product[]>;
  for (const product of products) {
    (acc[product.category] ??= []).push(product);
  }
  return acc;
}

/** Projects the registry as fully non-public — used only when this isolate
    has no last-known-good yet. Forces every product's status to 'hidden'
    (already means "withdraw everywhere" per isProductPublic) rather than
    leaving it undefined, which isProductPublic treats as 'active'. */
function buildFailClosedProjection(registryCatalog: CeramicCatalog): CeramicCatalog {
  const products: Product[] = registryCatalog.products.map((p) => ({ ...p, status: 'hidden' }));
  return {
    products,
    byId: new Map(products.map((p) => [p.id, p])),
    byCategory: groupByCategory(products),
  };
}

/**
 * Resolve the value `loadCeramicCatalog()` should pass to `readWithFallback`
 * as its fallback: this isolate's last-known-good catalog if it has served
 * one, otherwise a fail-closed projection of `registryCatalog`. Returns the
 * tier alongside so the caller can tag the Sentry report distinctly from a
 * generic Supabase hiccup.
 */
export function resolveCeramicCatalogFallback(
  registryCatalog: CeramicCatalog,
): { catalog: CeramicCatalog; tier: FallbackTier } {
  if (lastGood) return { catalog: lastGood, tier: 'last-known-good' };
  return { catalog: buildFailClosedProjection(registryCatalog), tier: 'cold-fail-closed' };
}
