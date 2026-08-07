/* ============================================================
   Print pricing config loader — cached DB read for the storefront accessor.
   Mirrors src/lib/catalog/load.ts: cached under the shared `catalog` tag so
   the existing revalidateCatalog() helper (admin writes) busts it too.
   Server-only (getSupabaseAdmin needs the Workers request context); reached
   via dynamic import from ./get.ts so `code` mode and client bundles never
   touch it.
   ============================================================ */
import { unstable_cache } from 'next/cache';
import { getSupabaseAdmin } from '../supabase';
import type { PrintPricingConfig } from '../print-pricing';
import { readPrintPricingConfig } from './repository';

export const loadPrintPricingConfigFromDb: () => Promise<PrintPricingConfig> = unstable_cache(
  async () => readPrintPricingConfig(getSupabaseAdmin()),
  ['print-pricing-config'],
  { tags: ['catalog'], revalidate: 300 },
);
