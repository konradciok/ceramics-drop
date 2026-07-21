/**
 * Generate storefront gallery WebPs from a published fulfilment derivative,
 * upload them to R2 under `prints/{productId}/gallery/{slot}/`, and mirror
 * the same files to `public/uploads/` for static `srcSet()` delivery.
 *
 * Usage:
 *   npm run print-assets:gallery -- --product fap01
 *   npm run print-assets:gallery -- --product fap01 --slot hero --revision 2026-07-12-r1
 *   npm run print-assets:gallery -- --product fap01 --dry-run
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and Wrangler R2 access.
 * Gallery slot config lives in `config/print-assets/{productId}.json` → `gallery`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { profileKeyFromPx, type PrepareConfig } from '../src/lib/print-assets-prepare';
import { IMG_WIDTHS } from '../src/lib/images';
import { parseScriptArgs, PRINT_ASSET_ARG_SPECS, localDerivativePath, tryLoadManifestV2, ROOT } from './lib/print-assets-cli';
import { hashFile } from './lib/image-facts';
import {
  galleryR2Key,
  resolveLatestReadyAsset,
  type ReadyAssetDetail,
} from './lib/print-assets-resolve';
import { printAssetsBucket, r2GetToFile, r2Put } from './lib/r2';

const CANONICAL_MAX_WIDTH = 1600;
const UPLOADS_DIR = path.join(ROOT, 'public', 'uploads');
const WEBP_QUALITY = 80;

function loadConfig(productId: string): PrepareConfig {
  const configPath = path.join(ROOT, 'config', 'print-assets', `${productId}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No config at ${path.relative(ROOT, configPath)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PrepareConfig;
  if (parsed.product !== productId) {
    throw new Error(`Config declares product "${parsed.product}", expected "${productId}"`);
  }
  return parsed;
}

/**
 * Resolve a local JPG/PNG derivative path when the prepare output tree exists;
 * otherwise download the immutable R2 fulfilment object to a scratch file.
 */
async function resolveSourcePath(
  productId: string,
  asset: ReadyAssetDetail,
  scratchDir: string,
  bucket: string,
): Promise<{ path: string; cleanup: boolean }> {
  // A valid local schema-v2 manifest lets us reuse the exact prepared derivative.
  // A missing or recognized-legacy local manifest returns null (→ verified R2
  // fallback below); a malformed/unknown local manifest THROWS before any R2 access.
  const manifest = tryLoadManifestV2(productId, asset.revision);
  if (manifest) {
    const derivative = manifest.derivatives.find((d) => profileKeyFromPx(d.width, d.height) === asset.profile_key);
    if (derivative) {
      const localPath = localDerivativePath(
        productId,
        asset.revision,
        asset.profile_key,
        derivative.sha256,
        derivative.format,
      );
      if (fs.existsSync(localPath)) {
        return { path: localPath, cleanup: false };
      }
    }
  }

  const ext = path.extname(asset.r2_key) || '.jpg';
  const dest = path.join(scratchDir, `source-${asset.profile_key}${ext}`);
  const got = r2GetToFile(bucket, asset.r2_key, dest);
  if (!got.ok) {
    throw new Error(`Failed to download fulfilment source ${asset.r2_key}: ${got.error}`);
  }
  const downloadedSha = await hashFile(dest);
  if (downloadedSha !== asset.sha256) {
    throw new Error(
      `Integrity mismatch for ${asset.r2_key}: expected sha256 ${asset.sha256}, got ${downloadedSha}`,
    );
  }
  return { path: dest, cleanup: true };
}

interface WebpOutput {
  filename: string;
  localPath: string;
  r2Key: string;
  publicPath: string;
}

async function generateWebpSet(
  sourcePath: string,
  stem: string,
  scratchDir: string,
): Promise<WebpOutput[]> {
  const outputs: WebpOutput[] = [];

  const canonicalName = `${stem}.webp`;
  const canonicalPath = path.join(scratchDir, canonicalName);
  await sharp(sourcePath)
    .resize({ width: CANONICAL_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(canonicalPath);
  outputs.push({
    filename: canonicalName,
    localPath: canonicalPath,
    r2Key: '',
    publicPath: `/uploads/${canonicalName}`,
  });

  for (const w of IMG_WIDTHS) {
    const variantName = `${stem}-${w}w.webp`;
    const variantPath = path.join(scratchDir, variantName);
    await sharp(sourcePath)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(variantPath);
    outputs.push({
      filename: variantName,
      localPath: variantPath,
      r2Key: '',
      publicPath: `/uploads/${variantName}`,
    });
  }

  return outputs;
}

async function main(): Promise<void> {
  const args = parseScriptArgs(PRINT_ASSET_ARG_SPECS.gallery);
  const productId = args.product;
  const slot = args.slot ?? 'hero';
  const revisionArg = args.revision;
  const dryRun = args['dry-run'] === true;

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');

  const config = loadConfig(productId);
  const slotConfig = config.gallery?.[slot];
  if (!slotConfig) {
    throw new Error(
      `No gallery.${slot} in config/print-assets/${productId}.json — add sourceProfile + uploadStem.`,
    );
  }

  const asset = await resolveLatestReadyAsset(productId, slotConfig.sourceProfile, revisionArg);
  const bucket = printAssetsBucket();
  const stem = slotConfig.uploadStem;

  console.log(
    `print-assets:gallery — product=${productId} slot=${slot} revision=${asset.revision} ` +
      `profile=${asset.profile_key} bucket=${bucket}`,
  );
  console.log(`  source: ${asset.r2_key}`);
  console.log(`  upload stem: ${stem}${dryRun ? '  [DRY RUN]' : ''}`);

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-gallery-'));
  try {
    const { path: sourcePath } = await resolveSourcePath(productId, asset, scratchDir, bucket);
    const webps = await generateWebpSet(sourcePath, stem, scratchDir);

    for (const file of webps) {
      file.r2Key = galleryR2Key(productId, slot, file.filename);
      const sizeKb = (fs.statSync(file.localPath).size / 1024).toFixed(0);
      if (dryRun) {
        console.log(`  would write R2 ${file.r2Key} (${sizeKb} KB)`);
        console.log(`  would mirror ${file.publicPath}`);
        continue;
      }

      const put = r2Put(bucket, file.r2Key, file.localPath, 'image/webp');
      if (!put.ok) throw new Error(`R2 upload failed for ${file.r2Key}: ${put.error}`);

      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const dest = path.join(ROOT, 'public', file.publicPath);
      fs.copyFileSync(file.localPath, dest);
      console.log(`  ${file.filename}  → R2 + ${file.publicPath}  (${sizeKb} KB)`);
    }

    if (!dryRun) {
      console.log(`\nDone. Gallery slot "${slot}" mirrored to public/uploads/${stem}*.webp`);
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
