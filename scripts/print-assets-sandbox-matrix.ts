/**
 * Place one Prodigi sandbox order per distinct print-area profile for a design.
 * Uses production signed asset URLs (anna-ciok.studio) so Prodigi downloads the
 * same bytes checkout would send.
 *
 *   npm run print-assets:sandbox-matrix -- --product fap01 [--dry-run]
 */
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { getWorkerOrigin } from '../src/lib/site.server';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

const MATRIX: Array<{
  profileKey: string;
  variantKey: string;
  sku: string;
  attributes: Record<string, string>;
}> = [
  { profileKey: '3600x4800', variantKey: '30x40:false:false:none', sku: 'GLOBAL-FAP-12X16', attributes: {} },
  { profileKey: '3614x4795', variantKey: '30x40:true:false:black', sku: 'GLOBAL-CFP-12X16', attributes: { color: 'black' } },
  {
    profileKey: '2400x3600',
    variantKey: '30x40:true:true:black',
    sku: 'GLOBAL-CFPM-12X16',
    attributes: { color: 'black', mount: '2.4mm', mountColor: 'Snow white' },
  },
  { profileKey: '6000x8400', variantKey: '50x70:false:false:none', sku: 'GLOBAL-FAP-20X28', attributes: {} },
  {
    profileKey: '4800x7200',
    variantKey: '50x70:true:true:black',
    sku: 'GLOBAL-CFPM-20X28',
    attributes: { color: 'black', mount: '2.4mm', mountColor: 'Snow white' },
  },
  { profileKey: '8400x12000', variantKey: '70x100:false:false:none', sku: 'GLOBAL-FAP-28X40', attributes: {} },
  {
    profileKey: '7200x10800',
    variantKey: '70x100:true:true:black',
    sku: 'GLOBAL-CFPM-28X40',
    attributes: { color: 'black', mount: '2.4mm', mountColor: 'Snow white' },
  },
];

function parseArgs(): { product: string; dryRun: boolean } {
  const argv = process.argv.slice(2);
  let product = 'fap01';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--product') product = argv[++i] ?? product;
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: npm run print-assets:sandbox-matrix -- [--product fap01] [--dry-run]');
      process.exit(0);
    }
  }
  return { product, dryRun };
}

async function main(): Promise<void> {
  const { product, dryRun } = parseArgs();
  const env = loadLocalEnv();
  const apiKey = env.PRODIGI_API_KEY_SANDBOX;
  const secret = env.PRINT_ASSET_TOKEN_SECRET;
  if (!apiKey) throw new Error('PRODIGI_API_KEY_SANDBOX required');
  if (!secret) throw new Error('PRINT_ASSET_TOKEN_SECRET required');

  const supabase = loadSupabaseClient();
  const { data: assets, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, profile_key, revision, status')
    .eq('product_id', product)
    .eq('status', 'ready');
  if (error) throw new Error(`asset lookup failed: ${error.message}`);

  const byProfile = new Map((assets ?? []).map((a) => [a.profile_key, a]));
  const origin = getWorkerOrigin({ WORKER_ORIGIN: env.WORKER_ORIGIN }).replace(/\/$/, '');
  const runId = new Date().toISOString().slice(0, 10);
  const results: Array<Record<string, unknown>> = [];

  for (const row of MATRIX) {
    const asset = byProfile.get(row.profileKey);
    if (!asset) {
      throw new Error(`no ready asset for profile ${row.profileKey} on ${product}`);
    }
    const signedUrl = await signPrintAssetUrl(asset.id, secret, Date.now(), origin);
    const idempotencyKey = `${product}-sandbox-matrix-${runId}-${row.profileKey}`;
    const payload = {
      idempotencyKey,
      merchantReference: idempotencyKey,
      shippingMethod: 'Budget',
      recipient: {
        name: 'Sandbox Matrix Recipient',
        email: 'sandbox-matrix@example.invalid',
        phoneNumber: '+48111111111',
        address: {
          line1: '1 Test Street',
          postalOrZipCode: '00-001',
          countryCode: 'PL',
          townOrCity: 'Warsaw',
        },
      },
      items: [
        {
          sku: row.sku,
          copies: 1,
          sizing: 'fillPrintArea',
          attributes: row.attributes,
          assets: [{ printArea: 'default', url: signedUrl }],
        },
      ],
      metadata: {
        purpose: 'sandbox-matrix',
        product,
        profileKey: row.profileKey,
        variantKey: row.variantKey,
        assetId: asset.id,
        revision: asset.revision,
      },
    };

    if (dryRun) {
      results.push({ profileKey: row.profileKey, variantKey: row.variantKey, sku: row.sku, assetId: asset.id, dryRun: true });
      continue;
    }

    const res = await fetch('https://api.sandbox.prodigi.com/v4.0/orders', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        `Prodigi order failed for ${row.profileKey} (${res.status}): ${JSON.stringify(body)}`,
      );
    }
    const ordId = (body as { order?: { id?: string } })?.order?.id ?? null;
    results.push({
      profileKey: row.profileKey,
      variantKey: row.variantKey,
      sku: row.sku,
      assetId: asset.id,
      prodigiOrderId: ordId,
      status: (body as { order?: { status?: { stage?: string } } })?.order?.status?.stage ?? null,
    });
    console.log(`✓ ${row.profileKey} → ${ordId ?? '(no id)'}`);
  }

  console.log(JSON.stringify({ product, runId, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
