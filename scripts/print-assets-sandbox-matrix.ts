/**
 * Place one Prodigi sandbox order per distinct print-area profile for a design.
 * Uses production signed asset URLs (anna-ciok.studio) so Prodigi downloads the
 * same bytes checkout would send.
 *
 *   npm run print-assets:sandbox-matrix -- --product fap01 [--dry-run] [--run-id 2026-07-13-r2]
 */
import { parseArgs as nodeParseArgs } from 'node:util';
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { getWorkerOrigin } from '../src/lib/site.server';
import { buildSandboxMatrix, resolveLatestReadyByProfile } from './lib/print-assets-resolve';
import { loadLocalEnv } from './lib/script-env';

const PRODIGI_FETCH_TIMEOUT_MS = 15_000;

function parseArgs(): { product: string; dryRun: boolean; runId?: string } {
  const { values } = nodeParseArgs({
    options: {
      product: { type: 'string' },
      'run-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });
  if (values.help) {
    console.log(
      'Usage: npm run print-assets:sandbox-matrix -- [--product fap01] [--run-id <suffix>] [--dry-run]',
    );
    process.exit(0);
  }
  return {
    product: typeof values.product === 'string' ? values.product : 'fap01',
    dryRun: values['dry-run'] === true,
    runId: typeof values['run-id'] === 'string' ? values['run-id'] : undefined,
  };
}

/** UTC date + minute — unique per run unless --run-id overrides. */
function defaultRunId(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 16).replace(':', '')}`;
}

async function main(): Promise<void> {
  const { product, dryRun, runId: runIdArg } = parseArgs();
  const env = loadLocalEnv();
  const apiKey = env.PRODIGI_API_KEY_SANDBOX;
  const secret = env.PRINT_ASSET_TOKEN_SECRET;
  if (!apiKey) throw new Error('PRODIGI_API_KEY_SANDBOX required');
  if (!secret) throw new Error('PRINT_ASSET_TOKEN_SECRET required');

  const byProfile = await resolveLatestReadyByProfile(product);
  const matrix = buildSandboxMatrix();
  const origin = getWorkerOrigin({ WORKER_ORIGIN: env.WORKER_ORIGIN }).replace(/\/$/, '');
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PRODIGI_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.sandbox.prodigi.com/v4.0/orders', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        failures++;
        const err = `Prodigi order failed (${res.status}): ${JSON.stringify(body)}`;
        results.push({
          profileKey: row.profileKey,
          variantKey: row.variantKey,
          sku: row.sku,
          assetId: asset.id,
          idempotencyKey,
          error: err,
        });
        console.error(`✗ ${row.profileKey} — ${err}`);
        continue;
      }
      const ordId = (body as { order?: { id?: string; status?: { stage?: string } } })?.order?.id ?? null;
      const stage = (body as { order?: { status?: { stage?: string } } })?.order?.status?.stage ?? null;
      results.push({
        profileKey: row.profileKey,
        variantKey: row.variantKey,
        sku: row.sku,
        assetId: asset.id,
        idempotencyKey,
        prodigiOrderId: ordId,
        status: stage,
      });
      console.log(`✓ ${row.profileKey} → ${ordId ?? '(no id)'}`);
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
    } finally {
      clearTimeout(timeout);
    }
  }

  console.log(JSON.stringify({ product, runId, failures, results }, null, 2));
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
