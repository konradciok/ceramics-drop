/**
 * Deployed smoke probe for /api/print-assets/[id] — HEAD a freshly minted
 * signed URL against a live origin. Never logs `sig`.
 *
 *   npm run print-asset:smoke -- [--origin https://anna-ciok.studio] [--asset-id <uuid>] [--json]
 *   npm run print-asset:smoke -- --env-file .dev.vars
 *
 * Requires PRINT_ASSET_TOKEN_SECRET + Supabase (to resolve a ready asset when
 * --asset-id is omitted). Exits non-zero when HEAD is not 200 or metadata is missing.
 */
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { probeSignedPrintAssetHead } from '../src/lib/print-asset-smoke';
import { SITE_URL } from '../src/lib/site';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

async function resolveAssetId(
  explicit: string | undefined,
): Promise<{ assetId: string; productId: string; profileKey: string }> {
  if (explicit) {
    const supabase = loadSupabaseClient();
    const { data, error } = await supabase
      .from('print_fulfilment_assets')
      .select('id, product_id, profile_key, status')
      .eq('id', explicit)
      .maybeSingle();
    if (error) throw new Error(`asset lookup failed: ${error.message}`);
    if (!data) throw new Error(`unknown asset id: ${explicit}`);
    if (data.status !== 'ready' && data.status !== 'retired') {
      throw new Error(`asset ${explicit} is ${data.status} — probe requires ready or retired`);
    }
    return { assetId: data.id, productId: data.product_id, profileKey: data.profile_key };
  }

  const supabase = loadSupabaseClient();
  const { data, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, product_id, profile_key')
    .in('status', ['ready', 'retired'])
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`asset lookup failed: ${error.message}`);
  if (!data) {
    throw new Error(
      'no ready/retired print_fulfilment_assets row — run prepare/upload/verify/publish first',
    );
  }
  return { assetId: data.id, productId: data.product_id, profileKey: data.profile_key };
}

function parseArgs(): { origin: string; assetId?: string; json: boolean } {
  const argv = process.argv.slice(2);
  let origin = process.env.WORKER_ORIGIN ?? SITE_URL;
  let assetId: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--origin') origin = argv[++i] ?? origin;
    else if (argv[i] === '--asset-id') assetId = argv[++i];
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`Usage: npm run print-asset:smoke -- [--origin <url>] [--asset-id <uuid>] [--json] [--env-file <path>]`);
      process.exit(0);
    }
  }
  return { origin, assetId, json };
}

async function main(): Promise<void> {
  const { origin, assetId: explicitAssetId, json } = parseArgs();
  const env = loadLocalEnv();
  const secret = env.PRINT_ASSET_TOKEN_SECRET;
  if (!secret) {
    throw new Error('PRINT_ASSET_TOKEN_SECRET required (.dev.vars / --env-file / process env)');
  }

  const { assetId, productId, profileKey } = await resolveAssetId(explicitAssetId);
  const signedUrl = await signPrintAssetUrl(assetId, secret, Date.now(), origin.replace(/\/$/, ''));
  const probe = await probeSignedPrintAssetHead(signedUrl);

  const report = {
    probedAt: new Date().toISOString(),
    origin: origin.replace(/\/$/, ''),
    assetId,
    productId,
    profileKey,
    ...probe,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (probe.ok) {
    console.log(
      `OK HEAD ${probe.status}  asset=${assetId}  product=${productId}  profile=${profileKey}`,
    );
    console.log(`  url: ${probe.url}`);
    console.log(`  content-type: ${probe.contentType}  content-length: ${probe.contentLength}  etag: ${probe.etag ?? '—'}`);
  } else {
    console.error(
      `FAIL HEAD ${probe.status || 'network'}  asset=${assetId}  product=${productId}  profile=${profileKey}`,
    );
    console.error(`  url: ${probe.url}`);
    if (probe.error) console.error(`  error: ${probe.error}`);
  }

  if (!probe.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
