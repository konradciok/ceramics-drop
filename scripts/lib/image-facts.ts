/**
 * Read back the verifiable facts of a downloaded R2 object for
 * scripts/print-assets-verify.ts: the full SHA-256 (streamed, so a large print
 * master is never held whole in a JS Buffer) and the decoded pixel dimensions.
 *
 * Sharp is a native binding, so — like scripts/lib/prepare-derivatives.ts —
 * this stays under scripts/lib/, never src/lib/ (which bundles into the
 * Workers runtime).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { RemoteObjectFacts } from '../../src/lib/print-assets-publish';

/** Full SHA-256 of a file, hashed from a read stream (constant memory). */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The facts `compareRemoteToManifest` checks: streamed hash, byte size (from
 * the filesystem, not a buffered length), and Sharp-decoded dimensions (reads
 * only the image header, not the full raster).
 */
export async function readObjectFacts(filePath: string): Promise<RemoteObjectFacts> {
  const [sha256, meta, stat] = await Promise.all([
    hashFile(filePath),
    sharp(filePath).metadata(),
    fs.promises.stat(filePath),
  ]);
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) {
    throw new Error(`Could not decode image dimensions from downloaded object: ${filePath}`);
  }
  return { sha256, byteSize: stat.size, width, height };
}
