/**
 * Deployed smoke probe for /api/print-assets/[id] — HEAD a freshly minted
 * signed URL against a live origin. Never logs `sig`.
 *
 *   npm run print-asset:smoke -- [--origin https://anna-ciok.studio] [--asset-id <uuid>] [--json] [--allow-missing]
 *   npm run print-asset:smoke -- --env-file .dev.vars
 *
 * Requires PRINT_ASSET_TOKEN_SECRET + Supabase (to resolve a ready asset when
 * --asset-id is omitted). Exits non-zero when HEAD is not 200 or metadata is
 * missing. --allow-missing downgrades the "no ready/retired asset" case to an
 * exit-0 skip (for pre-launch CI, where no asset is published yet); an explicit
 * --asset-id that is missing/wrong-status still errors.
 */
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { probeSignedPrintAssetHead } from '../src/lib/print-asset-smoke';
import { getWorkerOrigin } from '../src/lib/site.server';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

/**
 * Prefer a `ready` asset (proves something sellable is live); only fall back
 * to `retired` when no `ready` row exists (proves historical fulfilment still
 * serves, e.g. right after a revision swap).
 */
async function resolveAssetId(
  explicit: string | undefined,
  allowMissing: boolean,
): Promise<{ assetId: string; productId: string; profileKey: string } | null> {
  const supabase = loadSupabaseClient();

  if (explicit) {
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

  for (const status of ['ready', 'retired'] as const) {
    const { data, error } = await supabase
      .from('print_fulfilment_assets')
      .select('id, product_id, profile_key')
      .eq('status', status)
      .order('verified_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`asset lookup failed: ${error.message}`);
    if (data) return { assetId: data.id, productId: data.product_id, profileKey: data.profile_key };
  }

  if (allowMissing) return null;
  throw new Error(
    'no ready/retired print_fulfilment_assets row — run prepare/upload/verify/publish first',
  );
}

function parseArgs(): { origin?: string; assetId?: string; json: boolean; allowMissing: boolean } {
  const argv = process.argv.slice(2);
  let origin: string | undefined;
  let assetId: string | undefined;
  let json = false;
  let allowMissing = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--origin') origin = argv[++i] ?? origin;
    else if (argv[i] === '--asset-id') assetId = argv[++i];
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--allow-missing') allowMissing = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`Usage: npm run print-asset:smoke -- [--origin <url>] [--asset-id <uuid>] [--json] [--allow-missing] [--env-file <path>]`);
      process.exit(0);
    }
  }
  return { origin, assetId, json, allowMissing };
}

async function main(): Promise<void> {
  const { origin: originOverride, assetId: explicitAssetId, json, allowMissing } = parseArgs();
  const env = loadLocalEnv();
  const secret = env.PRINT_ASSET_TOKEN_SECRET;
  if (!secret) {
    throw new Error('PRINT_ASSET_TOKEN_SECRET required (.dev.vars / --env-file / process env)');
  }

  const origin = originOverride ?? getWorkerOrigin({ WORKER_ORIGIN: env.WORKER_ORIGIN });
  const resolved = await resolveAssetId(explicitAssetId, allowMissing);
  if (!resolved) {
    // --allow-missing: no sellable asset yet (pre-launch). Exit 0 so the
    // post-deploy smoke stays green until a real asset is published.
    const reason = 'skipped: no sellable asset yet';
    if (json) console.log(JSON.stringify({ skipped: true, reason }, null, 2));
    else console.log(reason);
    return;
  }
  const { assetId, productId, profileKey } = resolved;
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
