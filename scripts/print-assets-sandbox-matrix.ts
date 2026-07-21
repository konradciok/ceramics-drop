/**
 * Place one Prodigi sandbox order per distinct print-area profile for a design.
 * Uses production signed asset URLs (anna-ciok.studio) so Prodigi downloads the
 * same bytes checkout would send.
 *
 *   npm run print-assets:sandbox-matrix -- --product fap01 [--dry-run] [--run-id 2026-07-13-r2]
 */
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { getWorkerOrigin } from '../src/lib/site.server';
import { buildSandboxMatrix, resolveLatestReadyByProfile } from './lib/print-assets-resolve';
import { loadLocalEnv } from './lib/script-env';
import { parseSandboxArgs, defaultRunId, postSandboxOrder } from './lib/print-assets-sandbox-matrix';

async function main(): Promise<void> {
  const { product, dryRun, runId: runIdArg, help } = parseSandboxArgs(process.argv.slice(2));
  if (help) {
    console.log(
      'Usage: npm run print-assets:sandbox-matrix -- [--product fap01] [--run-id <suffix>] [--dry-run]',
    );
    process.exit(0);
  }
  const env = loadLocalEnv();
  const apiKey = env.PRODIGI_API_KEY_SANDBOX;
  const secret = env.PRINT_ASSET_TOKEN_SECRET;
  if (!apiKey) throw new Error('PRODIGI_API_KEY_SANDBOX required');
  if (!secret) throw new Error('PRINT_ASSET_TOKEN_SECRET required');

  const byProfile = await resolveLatestReadyByProfile(product);
  const matrix = buildSandboxMatrix();
  const origin = getWorkerOrigin({ WORKER_ORIGIN: env.WORKER_ORIGIN });
  const runId = runIdArg ?? defaultRunId();
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;

  for (const row of matrix) {
    const asset = byProfile.get(row.profileKey);
    if (!asset) {
      failures++;
      const err = `no ready asset for profile ${row.profileKey} on ${product}`;
      results.push({ profileKey: row.profileKey, variantKey: row.variantKey, error: err });
      console.error(`✗ ${row.profileKey} — ${err}`);
      continue;
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

    try {
      const { summary, classification } = await postSandboxOrder({ apiKey, payload });
      if (classification === 'success') {
        results.push({
          profileKey: row.profileKey,
          variantKey: row.variantKey,
          sku: row.sku,
          assetId: asset.id,
          idempotencyKey,
          prodigiOrderId: summary.orderId,
          status: summary.stage,
        });
        console.log(`✓ ${row.profileKey} → ${summary.orderId ?? '(no id)'}`);
      } else {
        // Duplicate (alreadyExists) or failure (createdWithIssues): keep the
        // row's own context; the response-derived part is only the sanitized
        // summary — never the raw response, which can echo the signed asset
        // URL back — and skip the success marker.
        failures++;
        results.push({
          profileKey: row.profileKey,
          variantKey: row.variantKey,
          sku: row.sku,
          assetId: asset.id,
          idempotencyKey,
          ...summary,
        });
        console.error(`✗ ${row.profileKey} — ${classification}: ${JSON.stringify(summary)}`);
      }
    } catch (err) {
      failures++;
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        profileKey: row.profileKey,
        variantKey: row.variantKey,
        sku: row.sku,
        assetId: asset.id,
        idempotencyKey,
        error: errMsg,
      });
      console.error(`✗ ${row.profileKey} — ${errMsg}`);
    }
  }

  console.log(JSON.stringify({ product, runId, failures, results }, null, 2));
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
