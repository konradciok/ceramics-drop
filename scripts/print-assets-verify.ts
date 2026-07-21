/**
 * Verify a revision's uploaded R2 objects against the manifest and promote
 * their staged rows to `ready` (Phase 2b of the print-asset pipeline —
 * docs/plans/print-asset-pipeline.md → Phase 2 `verify` bullets).
 *
 * First runs the local preflight (config ⇄ schema-v2 manifest agreement) — but
 * NOT the local-derivative check: verify inspects the remote R2 objects, which
 * may be verified from a different machine than the one that prepared them. Then
 * for every manifest derivative it re-downloads the R2 object, hashes it
 * (streamed), decodes its dimensions, and compares the full SHA-256, byte size,
 * and dimensions against the manifest. A full-hash match is the strong guarantee
 * the remote bytes are exactly what `prepare` produced.
 *
 * Only if every derivative verifies does it flip the corresponding
 * `print_fulfilment_assets` rows staged → ready (setting `verified_at`). Any
 * mismatch, missing row, or already-revoked/retired asset aborts with NO
 * promotion. Idempotent: rows already `ready` are left as-is.
 *
 * `--dry-run` still downloads and verifies every object (that IS the check) —
 * it only skips the staged → ready DB promotion. It does not write to R2.
 *
 * Usage:
 *   npm run print-assets:verify -- --product fap01 --revision 2026-07-11-r1
 *   npm run print-assets:verify -- --product fap01 --revision 2026-07-11-r1 --dry-run
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareRemoteToManifest } from '../src/lib/print-assets-publish';
import { derivativeR2Key, profileKeyFromPx } from '../src/lib/print-assets-prepare';
import { loadSupabaseClient } from './lib/script-env';
import { parseScriptArgs, PRINT_ASSET_ARG_SPECS } from './lib/print-assets-cli';
import { preflightPreparedRevision } from './lib/print-assets-preflight';
import { printAssetsBucket, r2GetToFile } from './lib/r2';
import { readObjectFacts } from './lib/image-facts';

async function main(): Promise<void> {
  const args = parseScriptArgs(PRINT_ASSET_ARG_SPECS.verify);
  const productId = args.product;
  const revision = args.revision;
  const dryRun = args['dry-run'] === true;

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-11-r1)');

  // Validate config + schema-v2 manifest BEFORE resolving the bucket or loading
  // Supabase. Verify does not require local derivatives (it checks R2).
  const { manifest } = await preflightPreparedRevision({ productId, revision, requireLocalDerivatives: false });

  const bucket = printAssetsBucket();
  console.log(`print-assets:verify — product=${productId} revision=${revision} bucket=${bucket}`);
  if (dryRun) console.log('  [DRY RUN] downloads + verifies every object; skips the staged → ready promotion.');

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-verify-'));
  const problems: string[] = [];
  try {
    // 1. Content verification: every remote object must match the manifest.
    for (const d of manifest.derivatives) {
      const profileKey = profileKeyFromPx(d.width, d.height);
      const r2Key = derivativeR2Key(manifest, d);
      process.stdout.write(`  ${profileKey}  ${r2Key}  … `);
      const dest = path.join(scratchDir, `${profileKey}-${d.sha256}.${d.format}`);
      const got = r2GetToFile(bucket, r2Key, dest);
      if (!got.ok) {
        console.log('MISSING');
        problems.push(`${r2Key}: not downloadable (${got.error})`);
        continue;
      }
      const facts = await readObjectFacts(dest);
      fs.rmSync(dest, { force: true });
      const errors = compareRemoteToManifest(d, facts);
      if (errors.length > 0) {
        console.log('MISMATCH');
        problems.push(...errors.map((e) => `${r2Key}: ${e}`));
      } else {
        console.log('ok');
      }
    }

    // 2. Row-state check: each derivative must have a promotable staged (or
    //    already-ready) DB row. Read before deciding so a revoked/retired asset
    //    is reported, not silently re-promoted.
    const supabase = loadSupabaseClient();
    const rows = await supabase
      .from('print_fulfilment_assets')
      .select('r2_key, status')
      .eq('product_id', productId)
      .eq('revision', revision);
    if (rows.error) throw new Error(`Failed to read staged assets: ${rows.error.message}`);
    const statusByKey = new Map((rows.data ?? []).map((r) => [r.r2_key as string, r.status as string]));

    const toPromote: string[] = [];
    let alreadyReady = 0;
    for (const d of manifest.derivatives) {
      const r2Key = derivativeR2Key(manifest, d);
      const status = statusByKey.get(r2Key);
      if (status === undefined) {
        problems.push(`${r2Key}: no print_fulfilment_assets row — run print-assets:upload first`);
      } else if (status === 'ready') {
        alreadyReady += 1;
      } else if (status === 'staged') {
        toPromote.push(r2Key);
      } else {
        problems.push(`${r2Key}: asset is "${status}" — cannot verify a retired/revoked asset`);
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `Verification failed — NOT promoting any asset:\n  - ${problems.join('\n  - ')}`,
      );
    }

    if (dryRun) {
      console.log(
        `\nDRY RUN — all ${manifest.derivatives.length} derivative(s) verified. Would promote ${toPromote.length} ` +
          `staged → ready (${alreadyReady} already ready).`,
      );
      return;
    }

    if (toPromote.length > 0) {
      const verifiedAt = new Date().toISOString();
      const promoted = await supabase
        .from('print_fulfilment_assets')
        .update({ status: 'ready', verified_at: verifiedAt })
        .eq('product_id', productId)
        .eq('revision', revision)
        .eq('status', 'staged')
        .in('r2_key', toPromote);
      if (promoted.error) throw new Error(`Failed to promote assets to ready: ${promoted.error.message}`);
    }

    console.log(
      `\nDone. Verified ${manifest.derivatives.length} derivative(s); promoted ${toPromote.length} → ready ` +
        `(${alreadyReady} already ready).`,
    );
    console.log('Next: npm run print-assets:publish to assign this revision to every active variant.');
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
