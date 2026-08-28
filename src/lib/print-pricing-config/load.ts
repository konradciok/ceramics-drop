/* ============================================================
   Print pricing config loader — direct DB read for the storefront accessor.
   Mirrors src/lib/catalog/load.ts: the deployed OpenNext tag cache is a dummy,
   so every invocation reads Supabase instead of promising ineffective cache
   invalidation.
   Server-only (getSupabaseAdmin needs the Workers request context); reached
   via dynamic import from ./get.ts so `code` mode and client bundles never
   touch it.
   ============================================================ */
import { getSupabaseAdmin } from '../supabase';
import type { PrintPricingConfig } from '../print-pricing';
import { readPrintPricingConfig } from './repository';

export async function loadPrintPricingConfigFromDb(): Promise<PrintPricingConfig> {
  return readPrintPricingConfig(getSupabaseAdmin());
}
