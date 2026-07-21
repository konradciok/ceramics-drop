/**
 * Byte-exact source selection for `scripts/print-assets-gallery.ts`: prefer
 * the local prepared derivative ONLY when its on-disk bytes hash to exactly
 * what the verified DB row claims, otherwise fall back to a hash-verified R2
 * download. Side-effect-free at import time (no CLI arg parsing, no config
 * loading) so tests can exercise `resolveGallerySource` directly without
 * pulling in the side-effecting CLI entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { profileKeyFromPx } from '../../src/lib/print-assets-prepare';
import { localDerivativePath, tryLoadManifestV2 } from './print-assets-cli';
import { hashFile } from './image-facts';
import { r2GetToFile } from './r2';
import type { ReadyAssetDetail } from './print-assets-resolve';

/**
 * Resolve a local JPG/PNG derivative path when the prepare output tree exists
 * AND its bytes hash to exactly `asset.sha256`; otherwise download the
 * immutable R2 fulfilment object to a scratch file and verify its hash before
 * returning it. A missing or recognized-legacy local manifest
 * (`tryLoadManifestV2` → null) falls through to the R2 path; a malformed or
 * unknown local manifest throws before any R2 access.
 */
export async function resolveGallerySource(
  productId: string,
  asset: ReadyAssetDetail,
  scratchDir: string,
  bucket: string,
): Promise<string> {
  const manifest = tryLoadManifestV2(productId, asset.revision);
  const derivative = manifest?.derivatives.find(
    (candidate) =>
      profileKeyFromPx(candidate.width, candidate.height) === asset.profile_key &&
      candidate.sha256 === asset.sha256,
  );
  if (derivative) {
    const profileKey = profileKeyFromPx(derivative.width, derivative.height);
    const localPath = localDerivativePath(
      productId,
      asset.revision,
      profileKey,
      derivative.sha256,
      derivative.format,
    );
    if (fs.existsSync(localPath) && (await hashFile(localPath)) === asset.sha256) {
      return localPath;
    }
  }
  const extension = path.extname(asset.r2_key) || '.jpg';
  const destination = path.join(scratchDir, `source-${asset.profile_key}${extension}`);
  const downloaded = r2GetToFile(bucket, asset.r2_key, destination);
  if (!downloaded.ok) throw new Error(`Failed to download fulfilment source ${asset.r2_key}: ${downloaded.error}`);
  const sha256 = await hashFile(destination);
  if (sha256 !== asset.sha256) {
    throw new Error(`Integrity mismatch for ${asset.r2_key}: expected ${asset.sha256}, got ${sha256}`);
  }
  return destination;
}
