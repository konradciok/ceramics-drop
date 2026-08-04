/**
 * One-off check after `npm run catalog:backfill`: no product_variants row may
 * still carry the pre-2026-08-03 black-frame contract (3614×4795) — the shared
 * 3600×4800 render is the asset contract for ALL 30x40 framed variants
 * (prodigi/decisions.md #6, `assetPx` in PRODIGI_SKU_MAP).
 *
 * Usage:
 *   npx tsx scripts/verify-print-area-contract.ts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env).
 * Exits 1 if any stale row remains.
 */
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnv } from './lib/script-env';

async function main(): Promise<void> {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { count: stale, error: staleErr } = await supabase
    .from('product_variants')
    .select('*', { count: 'exact', head: true })
    .eq('variant_key', '30x40:true:false:black')
    .eq('print_area_width_px', 3614)
    .eq('print_area_height_px', 4795);
  if (staleErr) throw new Error(`stale-row query failed: ${staleErr.message}`);

  const { count: shared, error: sharedErr } = await supabase
    .from('product_variants')
    .select('*', { count: 'exact', head: true })
    .eq('print_area_width_px', 3600)
    .eq('print_area_height_px', 4800);
  if (sharedErr) throw new Error(`shared-contract query failed: ${sharedErr.message}`);

  console.log(`rows still at 3614 (stale black-frame contract): ${stale ?? 0}`);
  console.log(`rows at 3600x4800 (shared 30x40 framed/loose contract): ${shared ?? 0}`);

  if ((stale ?? 0) > 0) {
    console.error('\nFAIL: stale contract rows remain — re-run `npm run catalog:backfill`.');
    process.exit(1);
  }
  console.log('\nOK: no stale black-frame contracts.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
