/* ============================================================
   Public accessor for the global print pricing config.
   Mirrors loadPrintCatalog (src/lib/prints.ts): CATALOG_SOURCE=code (local/
   tests) returns the code default; 'db' (production) reads the cached DB row
   and degrades to the default on failure so pricing never hard-fails a page
   or checkout. The dynamic import keeps Cloudflare-only code (supabase admin
   client, unstable_cache) out of the code-mode path and any client bundle.
   ============================================================ */
import { catalogSource } from '../catalog/source';
import { DEFAULT_PRINT_PRICING, type PrintPricingConfig } from '../print-pricing';

export async function getPrintPricingConfig(): Promise<PrintPricingConfig> {
  if (catalogSource() === 'code') return DEFAULT_PRINT_PRICING;
  try {
    const { loadPrintPricingConfigFromDb } = await import('./load');
    return await loadPrintPricingConfigFromDb();
  } catch (err) {
    console.error('[print-pricing] DB config read failed; falling back to code defaults', err);
    return DEFAULT_PRINT_PRICING;
  }
}
