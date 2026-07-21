/**
 * Upload a prepared revision's derivatives to R2 and stage their
 * `print_fulfilment_assets` rows (Phase 2b of the print-asset pipeline —
 * docs/plans/print-asset-pipeline.md → Phase 2 `upload` bullets).
 *
 * First runs the local preflight (config ⇄ manifest ⇄ on-disk source/derivative
 * byte-identity) — a rejected preflight makes NO external call. Then for each
 * distinct derivative:
 *   - probes the content-addressed R2 key; if an object already exists there,
 *     reuses it ONLY when its full streamed SHA-256 matches (a mismatch under
 *     an immutable key aborts — plan §2 "Never overwrite a key");
 *   - otherwise `wrangler r2 object put`s the local derivative with its exact
 *     content-type.
 * Only after EVERY upload succeeds does it stage the DB rows (status='staged').
 * Re-running after a partial failure is idempotent: already-staged keys with
 * matching bytes are skipped; a same-key/different-hash row aborts.
 *
 * Nothing here promotes assets to `ready` or assigns them — that is
 * print-assets:verify and print-assets:publish. No fulfilment path reads
 * `staged` assets.
 *
 * Usage:
 *   npm run print-assets:upload -- --product fap01 --revision 2026-07-11-r1
 *   npm run print-assets:upload -- --product fap01 --revision 2026-07-11-r1 --dry-run
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and an authenticated
 * Wrangler (`npx wrangler login` / CLOUDFLARE_API_TOKEN). Override the bucket
 * with PRINT_ASSETS_BUCKET for non-prod.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildStagedRows,
  decideUploadAction,
  partitionStagedRows,
  type RemoteProbe,
} from '../src/lib/print-assets-publish';
import { contentTypeForFormat, derivativeR2Key, profileKeyFromPx } from '../src/lib/print-assets-prepare';
import { loadSupabaseClient } from './lib/script-env';
import { parseScriptArgs, PRINT_ASSET_ARG_SPECS, localDerivativePath } from './lib/print-assets-cli';
import { preflightPreparedRevision } from './lib/print-assets-preflight';
import { printAssetsBucket, r2GetToFile, r2Put } from './lib/r2';
import { hashFile } from './lib/image-facts';

/**
 * Probe an R2 key: download it to a scratch file and hash it, `null` when the
 * object is definitively absent, or THROW when the get failed for any other
 * reason (auth, throttling, network). A transient fault must never be mistaken
 * for "absent" and fall through to an overwriting `r2Put` — fail closed.
 */
async function probeRemote(bucket: string, key: string, scratchDir: string): Promise<RemoteProbe | null> {
  const dest = path.join(scratchDir, `probe-${key.replace(/[^a-zA-Z0-9]/g, '_')}`);
  const got = r2GetToFile(bucket, key, dest);
  if (!got.ok) {
    if (got.kind === 'absent') return null;
    throw new Error(
      `Cannot determine whether ${key} already exists (get failed, not a clean not-found): ${got.error}. ` +
        'Refusing to upload — resolve the R2 access issue and re-run.',
    );
  }
  const sha256 = await hashFile(dest);
  fs.rmSync(dest, { force: true });
  return { sha256 };
}

async function main(): Promise<void> {
  const args = parseScriptArgs(PRINT_ASSET_ARG_SPECS.upload);
  const productId = args.product;
  const revision = args.revision;
  const dryRun = args['dry-run'] === true;

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-11-r1)');

  // Validate config + schema-v2 manifest + every local derivative BEFORE resolving
  // the bucket or loading Supabase (module boundary: no external calls on failure).
  const { manifest } = await preflightPreparedRevision({ productId, revision, requireLocalDerivatives: true });

  const bucket = printAssetsBucket();
  console.log(`print-assets:upload — product=${productId} revision=${revision} bucket=${bucket}`);
  console.log(`  ${manifest.derivatives.length} derivative(s)${dryRun ? '  [DRY RUN]' : ''}`);

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-upload-'));
  try {
    // 1. Upload (or reuse) every derivative before touching the database. A
    //    partial upload must not leave staged rows pointing at absent objects.
    for (const d of manifest.derivatives) {
      const profileKey = profileKeyFromPx(d.width, d.height);
      const r2Key = derivativeR2Key(manifest, d);
      const contentType = contentTypeForFormat(d.format);
      const localPath = localDerivativePath(productId, revision, profileKey, d.sha256, d.format);

      // Probe even in --dry-run: it's read-only, and skipping it would report
      // "would upload" for objects that already exist byte-identically.
      process.stdout.write(`  ${profileKey}  ${r2Key}  … `);
      const remote = await probeRemote(bucket, r2Key, scratchDir);
      const action = decideUploadAction({ sha256: d.sha256, r2Key }, remote);

      if (action === 'skip') {
        console.log('already present (hash match) — reuse');
        continue;
      }
      if (dryRun) {
        console.log('would upload');
        continue;
      }
      const put = r2Put(bucket, r2Key, localPath, contentType);
      if (!put.ok) {
        throw new Error(`Upload failed for ${r2Key}: ${put.error}`);
      }
      console.log(`uploaded (${(d.byteSize / 1024).toFixed(0)} KB, ${contentType})`);
    }

    // 2. Stage DB rows only after all uploads succeeded.
    const desired = buildStagedRows(manifest);
    const supabase = loadSupabaseClient();

    const existing = await supabase
      .from('print_fulfilment_assets')
      .select('r2_key, sha256')
      .eq('product_id', productId)
      .eq('revision', revision);
    if (existing.error) {
      throw new Error(`Failed to read existing staged assets: ${existing.error.message}`);
    }
    const existingByKey = new Map(
      (existing.data ?? []).map((r) => [r.r2_key as string, { sha256: r.sha256 as string }]),
    );

    const { toInsert, alreadyStaged, conflicts } = partitionStagedRows(desired, existingByKey);
    if (conflicts.length > 0) {
      throw new Error(
        `Refusing to stage: ${conflicts.length} key(s) already exist with a different sha256 (immutable-key ` +
          `violation):\n  - ${conflicts.join('\n  - ')}`,
      );
    }

    if (dryRun) {
      console.log(
        `\nDRY RUN — would insert ${toInsert.length} staged row(s), ${alreadyStaged.length} already staged.`,
      );
      return;
    }

    if (toInsert.length > 0) {
      const inserted = await supabase.from('print_fulfilment_assets').insert(toInsert);
      if (inserted.error) {
        throw new Error(`Failed to insert staged assets: ${inserted.error.message}`);
      }
    }

    console.log(
      `\nDone. Staged ${toInsert.length} new asset(s), ${alreadyStaged.length} already staged.`,
    );
    console.log('Next: npm run print-assets:verify to promote staged → ready.');
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
