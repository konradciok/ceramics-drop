/**
 * Verify and upsert all Prodigi SKUs into pod_variants (a SKU cache).
 *
 * Dimension authority: `product_variants.print_area_*_px` / `PRODIGI_SKU_MAP`
 * (per-variant catalogue contract, hand-verified). `pod_variants` is a cache and
 * is NON-authoritative — when a SKU's variants disagree on print-area pixels we
 * store NULL dimensions here and emit a warning so the operator knows the
 * per-variant catalogue contract is authoritative.
 *
 * This script enumerates EVERY variant a Prodigi product exposes (not just
 * `variants[0]`), flags intra-SKU disagreement and contract mismatches, and
 * exits non-zero if any problem is found.
 *
 * Expected non-zero exit: GLOBAL-CFP-12X16 currently reports intra-SKU
 * disagreement (3614×4795 vs 3600×4800 mounted variants). Upserts still succeed
 * with NULL cached dims in pod_variants; the per-variant catalogue contract in
 * product_variants / PRODIGI_SKU_MAP is authoritative for fulfilment.
 *
 * Run: npm run sync-prodigi-skus
 * Requires PRODIGI_API_KEY_SANDBOX and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env
 * (loaded from .dev.vars or .env.local automatically).
 */
import { createClient } from '@supabase/supabase-js';
import type { ProdigiProductResponse } from '../src/server/prodigi/types';
import { PRODIGI_SKU_MAP } from '../src/lib/print-cart';
import { validateProdigiDimensions, type ProdigiDimensionReport } from '../src/lib/print-dimensions';
import { loadLocalEnv } from './lib/script-env';

const merged = loadLocalEnv();

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PRODIGI_API_KEY_SANDBOX'] as const;
const missing = REQUIRED.filter((k) => !merged[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')} (set in .dev.vars or .env.local)`);
  process.exit(1);
}

const supabase = createClient(
  merged.SUPABASE_URL!,
  merged.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const env = {
  PRODIGI_ENV: 'sandbox',
  PRODIGI_API_KEY_SANDBOX: merged.PRODIGI_API_KEY_SANDBOX ?? '',
  PRODIGI_API_KEY_LIVE: '',
};

async function fetchProduct(sku: string): Promise<ProdigiProductResponse> {
  const res = await fetch(
    `https://api.sandbox.prodigi.com/v4.0/products/${sku}`,
    { headers: { 'X-API-Key': env.PRODIGI_API_KEY_SANDBOX } },
  );
  if (!res.ok) throw new Error(`GET /products/${sku} → ${res.status}`);
  return res.json() as Promise<ProdigiProductResponse>;
}

/** Render a per-SKU report block to stdout. */
function printReport(r: ProdigiDimensionReport): void {
  const sku = r.sku;
  console.log(`  ${sku}:`);
  if (r.unknownSku) {
    console.log(`    ⚠ SKU not present in PRODIGI_SKU_MAP — no contract to validate against`);
  }
  console.log(`    variants (${r.variants.length}):`);
  for (const v of r.variants) {
    console.log(`      [${v.index}] ${v.w}×${v.h}px`);
  }
  console.log(`    contract dims: ${r.contractDims.map((d) => `${d.w}×${d.h}`).join(', ') || '(none)'}`);
  if (r.intraSkuDisagreement) {
    console.log(`    ⚠ INTRA-SKU DISAGREEMENT — variants report different print-area pixels.`);
    console.log(`      pod_variants dims stored as NULL; per-variant catalogue contract is authoritative.`);
  }
  for (const m of r.contractMismatches) {
    console.log(`    ✗ MISMATCH variant [${m.variantIndex}] ${m.prodigi.w}×${m.prodigi.h}px vs contract {${r.contractDims.map((d) => `${d.w}×${d.h}`).join(' | ')}}`);
  }
}

async function main() {
  const uniqueSkus = [...new Set(Object.values(PRODIGI_SKU_MAP).map((v) => v.sku))];
  console.log(`Syncing ${uniqueSkus.length} unique SKUs…`);

  const failed: string[] = [];
  const problems: string[] = [];

  for (const sku of uniqueSkus) {
    let data: ProdigiProductResponse;
    try {
      data = await fetchProduct(sku);
    } catch (e) {
      console.log(`  ${sku}: FETCH FAILED ${(e as Error).message}`);
      failed.push(sku);
      continue;
    }

    const report = validateProdigiDimensions(data);
    printReport(report);
    if (report.hasProblem) problems.push(sku);

    // When variants disagree, do NOT store variants[0] as if authoritative.
    const agreeDims = !report.intraSkuDisagreement && report.variants.length > 0
      ? report.variants[0]
      : null;

    const { error } = await supabase.from('pod_variants').upsert({
      prodigi_sku: sku,
      display_size_label: sku,
      frame_colour: sku.includes('FAP') ? 'none' : 'varies',
      mount_enabled: sku.includes('CFPM'),
      print_area_width_px:  agreeDims?.w ?? null,
      print_area_height_px: agreeDims?.h ?? null,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'prodigi_sku' });

    if (error) { console.log(`    upsert ERROR ${error.message}`); failed.push(sku); }
  }

  console.log('');
  if (problems.length) {
    console.error(`⚠ ${problems.length}/${uniqueSkus.length} SKU(s) with dimension problems: ${problems.join(', ')}`);
    console.error('  Resolve in PRODIGI_SKU_MAP / product_variants.print_area_*_px (the dimension authority).');
  }
  if (failed.length) {
    console.error(`Failed to sync ${failed.length}/${uniqueSkus.length} SKU(s): ${failed.join(', ')}`);
  }

  if (failed.length || problems.length) process.exit(1);
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
