/**
 * Shared helpers for storefront-facing WebP generation (gallery + mockups):
 * resolve a fulfilment derivative to a local file (prepare tree or R2
 * download with sha256 integrity check) and emit the canonical + srcset WebP
 * set for public/uploads.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { IMG_WIDTHS } from '../../src/lib/images';
import { loadManifest, localDerivativePath, revisionDir } from './print-assets-cli';
import { hashFile } from './image-facts';
import { r2GetToFile } from './r2';
import type { ReadyAssetDetail } from './print-assets-resolve';

export const CANONICAL_MAX_WIDTH = 1600;
export const WEBP_QUALITY = 80;

export interface WebpOutput {
  filename: string;
  localPath: string;
  r2Key: string;
  publicPath: string;
}

export async function resolveSourcePath(
  productId: string,
  asset: ReadyAssetDetail,
  scratchDir: string,
  bucket: string,
): Promise<{ path: string; cleanup: boolean }> {
  const manifestPath = path.join(revisionDir(productId, asset.revision), 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = loadManifest(productId, asset.revision);
    const derivative = manifest.derivatives.find((d) => d.profileKey === asset.profile_key);
    if (derivative) {
      const localPath = localDerivativePath(
        productId,
        asset.revision,
        derivative.profileKey,
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

export async function generateWebpSet(
  source: Buffer | string,
  stem: string,
  scratchDir: string,
): Promise<WebpOutput[]> {
  const outputs: WebpOutput[] = [];

  const canonicalName = `${stem}.webp`;
  const canonicalPath = path.join(scratchDir, canonicalName);
  await sharp(source)
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
    await sharp(source)
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
