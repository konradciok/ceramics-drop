/**
 * Upload a prepared revision's derivatives to R2 and stage their
 * `print_fulfilment_assets` rows (Phase 2b of the print-asset pipeline —
 * docs/plans/print-asset-pipeline.md → Phase 2 `upload` bullets).
 *
 * Reads the `manifest.json` that print-assets:prepare wrote, then for each
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
import { loadSupabaseClient } from './lib/script-env';
import { getArg, hasFlag, loadManifest, localDerivativePath, ROOT } from './lib/print-assets-cli';
import { printAssetsBucket, r2GetToFile, r2Put } from './lib/r2';
import { hashFile } from './lib/image-facts';

/**
 * Probe an R2 key: download it to a scratch file and hash it, or `null` when
 * absent. A failed get is treated as "cannot prove present" → the caller
 * uploads (and an auth/network fault surfaces at put time, never as a silent
 * skip).
 */
async function probeRemote(bucket: string, key: string, scratchDir: string): Promise<RemoteProbe | null> {
  const dest = path.join(scratchDir, `probe-${key.replace(/[^a-zA-Z0-9]/g, '_')}`);
  const got = r2GetToFile(bucket, key, dest);
  if (!got.ok) return null;
  const sha256 = await hashFile(dest);
  fs.rmSync(dest, { force: true });
  return { sha256 };
}

async function main(): Promise<void> {
  const productId = getArg('product');
  const revision = getArg('revision');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-11-r1)');

  const manifest = loadManifest(productId, revision);
  const bucket = printAssetsBucket();
  console.log(`print-assets:upload — product=${productId} revision=${revision} bucket=${bucket}`);
  console.log(`  ${manifest.derivatives.length} derivative(s)${dryRun ? '  [DRY RUN]' : ''}`);

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-upload-'));
  try {
    // 1. Upload (or reuse) every derivative before touching the database. A
    //    partial upload must not leave staged rows pointing at absent objects.
    for (const d of manifest.derivatives) {
      const localPath = localDerivativePath(productId, revision, d.profileKey, d.sha256, d.format);
      if (!fs.existsSync(localPath)) {
        throw new Error(
          `Local derivative missing: ${path.relative(ROOT, localPath)}. Re-run print-assets:prepare — the manifest ` +
            'and its output files must come from the same run.',
        );
      }

      process.stdout.write(`  ${d.profileKey}  ${d.r2Key}  … `);
      const remote = dryRun ? null : await probeRemote(bucket, d.r2Key, scratchDir);
      const action = decideUploadAction(d, remote);

      if (action === 'skip') {
        console.log('already present (hash match) — reuse');
        continue;
      }
      if (dryRun) {
        console.log('would upload');
        continue;
      }
      const put = r2Put(bucket, d.r2Key, localPath, d.contentType);
      if (!put.ok) {
        throw new Error(`Upload failed for ${d.r2Key}: ${put.error}`);
      }
      console.log(`uploaded (${(d.byteSize / 1024).toFixed(0)} KB, ${d.contentType})`);
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
