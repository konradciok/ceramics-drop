/**
 * Verify and upsert all 21 Prodigi SKUs into pod_variants.
 * Run: npm run sync-prodigi-skus
 * Requires PRODIGI_API_KEY_SANDBOX and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */
import { createClient } from '@supabase/supabase-js';
import { PRODIGI_SKU_MAP } from '../src/lib/print-cart';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const env = {
  PRODIGI_ENV: 'sandbox',
  PRODIGI_API_KEY_SANDBOX: process.env.PRODIGI_API_KEY_SANDBOX!,
  PRODIGI_API_KEY_LIVE: '',
};

async function fetchProduct(sku: string) {
  const res = await fetch(
    `https://api.sandbox.prodigi.com/v4.0/products/${sku}`,
    { headers: { 'X-API-Key': env.PRODIGI_API_KEY_SANDBOX } },
  );
  if (!res.ok) throw new Error(`GET /products/${sku} → ${res.status}`);
  return res.json();
}

async function main() {
  const uniqueSkus = [...new Set(Object.values(PRODIGI_SKU_MAP).map((v) => v.sku))];
  console.log(`Syncing ${uniqueSkus.length} unique SKUs…`);

  for (const sku of uniqueSkus) {
    process.stdout.write(`  ${sku}… `);
    const data = await fetchProduct(sku);
    const variant = data.product?.variants?.[0];
    const printArea = variant?.printAreaSizes?.default;

    const { error } = await supabase.from('pod_variants').upsert({
      prodigi_sku: sku,
      display_size_label: sku,
      frame_colour: sku.includes('FAP') ? 'none' : 'varies',
      mount_enabled: sku.includes('CFPM'),
      print_area_width_px:  printArea?.horizontalResolution ?? null,
      print_area_height_px: printArea?.verticalResolution   ?? null,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'prodigi_sku' });

    if (error) { console.log('ERROR', error.message); continue; }
    console.log(`ok (${printArea?.horizontalResolution}×${printArea?.verticalResolution})`);
  }

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
