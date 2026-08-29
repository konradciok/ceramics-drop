/**
 * Backfill the shadow catalog tables (products / product_variants / product_media)
 * from the static code registry. Idempotent — safe to re-run after a catalogue
 * change; see backfillCatalog() in src/lib/catalog/repository.ts. The database
 * applies products plus replacement variants/media in one transaction. New
 * prints whose registry target is active are staged as draft until the guarded
 * status RPC verifies fulfilment readiness; existing registry-active print
 * statuses are preserved, rechecked after replacement, and registry-retired
 * prints remain archived.
 *
 * Usage:
 *   npm run catalog:backfill
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env).
 * Requires migrations 20260709140000_catalog_shadow (the tables), 20260709130000
 * (seeds the `drop-1` row that ceramic rows FK to), and 20260828120000 (the atomic
 * backfill RPC and print-publication guard). Run once against staging after merge,
 * then against production.
 */
import { createClient } from '@supabase/supabase-js';
import { backfillCatalog } from '../src/lib/catalog/repository';
import { buildCatalogSeed } from '../src/lib/catalog/seed';
import { loadLocalEnv } from './lib/script-env';

async function main(): Promise<void> {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const seed = buildCatalogSeed();
  await backfillCatalog(supabase);

  console.log('\nCatalog backfill complete.');
  console.log(`  products: ${seed.products.length}`);
  console.log(`  variants: ${seed.variants.length}`);
  console.log(`  media:    ${seed.media.length}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
