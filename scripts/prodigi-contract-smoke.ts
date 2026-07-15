/**
 * Prodigi v4 contract smoke (audit H-1). Drives a real sandbox lifecycle
 * (create → getOrder → actions → mapProdigiStage → cancel) through the production
 * mapper + client, proving the contract round-trips. Sandbox-only, self-cleaning.
 *
 *   npm run prodigi:contract-smoke -- [--product fap01] [--strict] [--json] [--env-file PATH]
 *
 * Requires PRODIGI_API_KEY_SANDBOX + PRINT_ASSET_TOKEN_SECRET + SUPABASE_*.
 * --strict: fail (exit 1) when no usable print asset exists; without it, that case
 *           is an exit-0 skip (pre-launch, mirroring print-asset:smoke).
 * --json:   emit only the JSON report.
 */
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { PRODIGI_SKU_MAP, parseVariantKey } from '../src/lib/print-cart';
import { getWorkerOrigin } from '../src/lib/site.server';
import { mapProdigiStage } from '../src/server/fulfilment/status-map';
import { prodigiClient } from '../src/server/prodigi/client';
import { runProdigiContractSmoke } from '../src/server/prodigi/contract-smoke';
import { buildProdigiPayload, type OrderRow, type PrintItemRow } from '../src/server/prodigi/mapper';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

type ReadyAssetFull = {
  id: string;
  r2_key: string;
  sha256: string;
  content_type: 'image/jpeg' | 'image/png';
  width_px: number;
  height_px: number;
  profile_key: string;
  revision: string;
};

function parseArgs(): { product: string; strict: boolean; json: boolean } {
  const argv = process.argv.slice(2);
  let product = 'fap01';
  let strict = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--product') product = argv[++i] ?? product;
    else if (argv[i] === '--strict') strict = true;
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: npm run prodigi:contract-smoke -- [--product fap01] [--strict] [--json] [--env-file PATH]');
      process.exit(0);
    }
  }
  return { product, strict, json };
}

/** UTC date + second — unique per run, folded into idempotencyKey + merchantReference.
 *  Second-granularity avoids two same-minute dispatches colliding on idempotencyKey. */
function runId(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Resolve one ready asset whose pixel dimensions match a known PRODIGI_SKU_MAP
 * variant — guarantees buildProdigiPayload's assertSnapshotDimensions passes.
 * Script-side query (getSupabaseAdmin is Workers-only; mirrors print-asset-smoke).
 */
async function resolveUsableAsset(
  product: string,
): Promise<{ variantKey: string; asset: ReadyAssetFull } | null> {
  const supabase = loadSupabaseClient();
  const { data, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, r2_key, sha256, content_type, width_px, height_px, profile_key, revision')
    .eq('product_id', product)
    .eq('status', 'ready')
    .order('verified_at', { ascending: false })
    .order('sha256', { ascending: false });
  if (error) throw new Error(`asset lookup failed: ${error.message}`);
  for (const row of (data ?? []) as ReadyAssetFull[]) {
    const variantKey = Object.keys(PRODIGI_SKU_MAP).find((vk) => {
      const px = PRODIGI_SKU_MAP[vk]!.printAreaPx;
      return px.w === row.width_px && px.h === row.height_px;
    });
    if (variantKey) return { variantKey, asset: row };
  }
  return null;
}

async function main(): Promise<void> {
  const { product, strict, json } = parseArgs();
  const env = loadLocalEnv();
  const apiKey = env.PRODIGI_API_KEY_SANDBOX;
  const secret = env.PRINT_ASSET_TOKEN_SECRET;
  if (!apiKey) throw new Error('PRODIGI_API_KEY_SANDBOX required (.dev.vars / --env-file / process env)');
  if (!secret) throw new Error('PRINT_ASSET_TOKEN_SECRET required (.dev.vars / --env-file / process env)');

  const origin = getWorkerOrigin({ WORKER_ORIGIN: env.WORKER_ORIGIN }).replace(/\/$/, '');

  const resolved = await resolveUsableAsset(product);
  if (!resolved) {
    const reason = `no ready print_fulfilment_assets row with a matching variant on ${product}`;
    if (strict) throw new Error(reason);
    const skip = { skipped: true, reason };
    console.log(json ? JSON.stringify(skip, null, 2) : `skipped: ${reason}`);
    return;
  }
  const { variantKey, asset } = resolved;
  const sel = parseVariantKey(variantKey);
  const skuMap = PRODIGI_SKU_MAP[variantKey]!;
  const signedUrl = await signPrintAssetUrl(asset.id, secret, Date.now(), origin);

  const order: OrderRow = {
    id: `contract-smoke-${runId()}`,
    currency: 'pln',
    email: 'contract-smoke@example.invalid',
    receiver_first_name: 'Contract',
    receiver_last_name: 'Smoke',
    receiver_phone: '+48111111111',
    shipping_address: {
      street: '1 Test Street',
      building_number: '1',
      city: 'Warsaw',
      post_code: '00-001',
      country_code: 'PL',
    },
    delivery_method: 'kurier',
  };

  const items: PrintItemRow[] = [
    {
      product_id: product,
      unit_price: 10000, // 100.00 PLN — major-unit formatted by the mapper; value irrelevant to the contract
      variant: {
        prodigiSku: skuMap.sku,
        framed: sel.framed,
        mount: sel.mount,
        frameColour: sel.frameColour,
        printAreaPx: skuMap.printAreaPx,
        assetId: asset.id,
        assetKey: asset.r2_key,
        assetSha256: asset.sha256,
        assetContentType: asset.content_type,
        assetWidthPx: asset.width_px,
        assetHeightPx: asset.height_px,
      },
    },
  ];
  const assetUrls: Record<string, string> = { [asset.id]: signedUrl };

  // Mapper env: sandbox so idempotencyKey/baseUrl resolve to sandbox values.
  // callbackUrl uses a clearly-non-real token when the prod token isn't present
  // (CI): cancelled sandbox orders don't deliver callbacks, and the shape — not
  // the token — is what the contract asserts.
  const mapperEnv = {
    PRODIGI_ENV: 'sandbox',
    PRODIGI_DEFAULT_SHIPPING_METHOD: env.PRODIGI_DEFAULT_SHIPPING_METHOD ?? 'Budget',
    PRODIGI_CALLBACK_TOKEN: env.PRODIGI_CALLBACK_TOKEN ?? 'contract-smoke-no-callback',
    WORKER_ORIGIN: origin,
  } as unknown as CloudflareEnv;

  const payload = buildProdigiPayload(order, items, assetUrls, mapperEnv);

  // Client env: sandbox only, sandbox key only. baseUrl() resolves to the sandbox
  // host regardless of the key value, so a misconfigured key fails closed (401)
  // and can never create a live order.
  const clientEnv = {
    PRODIGI_ENV: 'sandbox',
    PRODIGI_API_KEY_SANDBOX: apiKey,
    PRODIGI_API_KEY_LIVE: '',
  } as unknown as CloudflareEnv;

  const result = await runProdigiContractSmoke({
    client: prodigiClient(clientEnv),
    payload,
    mapStage: mapProdigiStage,
  });

  const report = {
    product,
    variantKey,
    sku: skuMap.sku,
    assetId: asset.id,
    ...result,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const tag = result.ok ? 'ok' : 'FAIL';
    const tail = result.ok ? '' : ' — re-run with --json for the full report';
    console.log(
      `${tag}: prodigi contract smoke (${product}/${variantKey}, order ${result.prodigiOrderId ?? '—'}, cancelled=${result.cancelled})${tail}`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
