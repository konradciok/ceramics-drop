/* ============================================================
   Public accessor for the global print pricing config.
   Mirrors loadPrintCatalog (src/lib/prints.ts): CATALOG_SOURCE=code (local/
   tests) returns the code default; 'db' (production) reads the current DB row
   and degrades to the default on failure so pricing never hard-fails a page
   or checkout. The dynamic import keeps Cloudflare-only code (supabase admin
   client) out of the code-mode path and any client bundle.
   ============================================================ */
import { catalogSource } from '../catalog/source';
import { DEFAULT_PRINT_PRICING, type PrintPricingConfig } from '../print-pricing';
import { readWithFallback } from '../supabase-timeout';

export async function getPrintPricingConfig(): Promise<PrintPricingConfig> {
  if (catalogSource() === 'code') return DEFAULT_PRINT_PRICING;
  return readWithFallback('print-pricing-config', async () => {
    const { loadPrintPricingConfigFromDb } = await import('./load');
    return await loadPrintPricingConfigFromDb();
  }, DEFAULT_PRINT_PRICING);
}
