/**
 * Sharp derivative generation for `scripts/print-assets-prepare.ts` (Phase 2a).
 *
 * This is the ONLY module in the print-asset-pipeline that touches Sharp for
 * derivative generation. It stays under scripts/lib/ (not src/lib/) — Sharp is
 * a native binding incompatible with the Cloudflare Workers runtime that
 * src/lib/ bundles into (mirrors why sync-prodigi-skus.ts's Node-only Prodigi
 * fetch logic lives in scripts/, not src/lib/).
 *
 * Pure crop/aspect/enlargement math lives in src/lib/print-assets-prepare.ts
 * and is validated by the caller (the script) before this module runs Sharp.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { DerivativeFormat } from '../../src/lib/print-assets-prepare';

export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DerivativeResult {
  sha256: string;
  byteSize: number;
  format: DerivativeFormat;
  buffer: Buffer;
}

/**
 * Extract `crop` from the source image, resize to exact target pixels, encode
 * as the requested format, and return the encoded bytes + their sha256.
 *
 * Deterministic: fixed JPEG quality (no default-jitter), no chroma-subsample
 * variance, and metadata explicitly stripped (Sharp strips by default unless
 * `.withMetadata()` is called) so two runs on the same input produce
 * byte-identical output.
 *
 * Fails fast with a descriptive error when the crop region extends past the
 * source's actual pixel bounds — Sharp's own `extract` error is generic
 * ("extract_area: bad extract area"), so we check first for a clearer message.
 */
export async function generateDerivative(
  sourcePath: string,
  crop: CropRegion,
  targetWidth: number,
  targetHeight: number,
  format: DerivativeFormat,
): Promise<DerivativeResult> {
  const source = sharp(sourcePath);
  const meta = await source.metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;

  if (crop.left < 0 || crop.top < 0 || crop.left + crop.width > sourceWidth || crop.top + crop.height > sourceHeight) {
    throw new Error(
      `Crop region {left:${crop.left}, top:${crop.top}, width:${crop.width}, height:${crop.height}} ` +
        `exceeds source dimensions ${sourceWidth}x${sourceHeight}`,
    );
  }

  let pipeline = sharp(sourcePath)
    .extract(crop)
    .resize(targetWidth, targetHeight, { fit: 'fill' });

  // JPG must never carry transparency (plan: "no alpha surprise" — flag it by
  // flattening onto white rather than letting the encoder silently drop it).
  if (format === 'jpg') {
    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    pipeline = pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false });
  }

  const buffer = await pipeline.toBuffer();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return { sha256, byteSize: buffer.byteLength, format, buffer };
}

/** Write a derivative buffer to disk, creating parent directories as needed. */
export function writeDerivative(outputPath: string, buffer: Buffer): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}
