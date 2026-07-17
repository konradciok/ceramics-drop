/**
 * Sharp composition for `scripts/print-assets-prepare.ts` (Phase 2a).
 *
 * This is the ONLY module in the print-asset-pipeline that touches Sharp for
 * derivative generation. It stays under scripts/lib/ (not src/lib/) — Sharp is
 * a native binding incompatible with the Cloudflare Workers runtime that
 * src/lib/ bundles into (mirrors why sync-prodigi-skus.ts's Node-only Prodigi
 * fetch logic lives in scripts/, not src/lib/).
 *
 * Pure placement math lives in src/lib/print-assets-prepare.ts and is
 * validated by the caller (the script) before this module runs Sharp.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { DerivativeFormat, Placement } from '../../src/lib/print-assets-prepare';

export interface ComposeInput {
  artworkPath: string;
  signatureSvgPath: string | null;
  background: string; // hex "#RRGGBB"
  placement: Placement; // from resolvePlacement (src/lib/print-assets-prepare.ts)
  target: { w: number; h: number };
  format: DerivativeFormat;
}

export interface DerivativeResult {
  sha256: string;
  byteSize: number;
  format: DerivativeFormat;
  buffer: Buffer;
}

/**
 * Compose one exact-pixel Prodigi derivative by layering the artwork master and
 * (optionally) an SVG signature onto a solid background canvas, using a resolved
 * proportional placement. Pure layout math lives in src/lib/print-assets-prepare.ts
 * and is validated by the caller before this runs Sharp.
 *
 * Deterministic: fixed JPEG quality / chroma / mozjpeg, fixed PNG settings, and a
 * fixed input file + placement → byte-identical output across runs. Sharp
 * colour-manages artwork into sRGB; `.withMetadata()` embeds the output sRGB
 * profile so the configured RGB background and artwork share one declared
 * colour space.
 *
 * An RGBA artwork master is acceptable here (unlike the old crop path): alpha
 * composites onto the configured opaque background, and the output is flattened —
 * no transparency reaches Prodigi.
 */
export async function composeDerivative(input: ComposeInput): Promise<DerivativeResult> {
  const { artworkPath, signatureSvgPath, background, placement, target, format } = input;

  // 1. Base canvas = exact target pixels, filled with the configured background.
  const canvas = sharp({
    create: { width: target.w, height: target.h, channels: 3, background },
  });

  // 2. Artwork: resize to the contain-computed output dims and place centred in its box.
  const artworkLayer = await sharp(artworkPath)
    .resize(placement.artworkOut.width, placement.artworkOut.height, { fit: 'fill' })
    .toBuffer();

  const overlays: sharp.OverlayOptions[] = [
    { input: artworkLayer, left: placement.artworkPos.x, top: placement.artworkPos.y },
  ];

  // 3. Signature: rasterise the SVG contained into its zone, place centred in the zone.
  if (signatureSvgPath && placement.signatureBox) {
    const zone = placement.signatureBox;
    const sigLayer = await sharp(signatureSvgPath)
      .resize(zone.width, zone.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();
    overlays.push({ input: sigLayer, left: zone.x, top: zone.y });
  }

  // Composite can promote an RGB canvas to RGBA when an overlay has alpha.
  // Flatten once for both encoders so even PNG fulfilment assets are explicitly
  // three-channel and cannot carry a latent alpha channel to Prodigi.
  let pipeline = canvas.composite(overlays).flatten({ background }).removeAlpha().withMetadata();

  if (format === 'jpg') {
    pipeline = pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false });
  }

  const buffer = await pipeline.toBuffer();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return { sha256, byteSize: buffer.byteLength, format, buffer };
}

/** Require a self-contained path-only SVG that Sharp can decode. */
export async function validateSignatureSvg(signatureSvgPath: string): Promise<void> {
  try {
    const source = fs.readFileSync(signatureSvgPath, 'utf8');
    const unsafeFeature = [
      { pattern: /<text\b/i, label: '<text> (convert lettering to outlined paths)' },
      { pattern: /<image\b/i, label: '<image> (embedded or external raster content)' },
      { pattern: /<foreignObject\b/i, label: '<foreignObject>' },
      { pattern: /<script\b/i, label: '<script>' },
      { pattern: /(?:href|xlink:href)\s*=\s*["'](?!#)[^"']+["']/i, label: 'an external href' },
    ].find(({ pattern }) => pattern.test(source));
    if (unsafeFeature) {
      throw new Error(
        `signature must be a self-contained path-only SVG; found ${unsafeFeature.label}`,
      );
    }
    const externalCssUrl = [...source.matchAll(/url\(\s*(["']?)([^)'"]+)\1\s*\)/gi)].find(
      ([, , value]) => !value.trim().startsWith('#'),
    );
    if (externalCssUrl) {
      throw new Error('signature must be a self-contained path-only SVG; found an external CSS url()');
    }

    const metadata = await sharp(signatureSvgPath).metadata();
    if (metadata.format !== 'svg' || !metadata.width || !metadata.height) {
      throw new Error(`expected SVG with non-zero dimensions, decoded ${metadata.format ?? 'unknown'}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Signature SVG is invalid: ${signatureSvgPath} (${reason})`);
  }
}

/** Write a derivative buffer to disk, creating parent directories as needed. */
export function writeDerivative(outputPath: string, buffer: Buffer): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

/**
 * Prepare a clean revision output directory. When `force` is set and the
 * directory already exists (a re-run of the same revision), remove it first
 * — otherwise a re-run with a different layout config can leave stale
 * `{profile}-{oldSha256}.{ext}` files beside a `manifest.json` that no longer
 * references them, which is confusing for Phase 2b's upload/verify step.
 */
export function prepareOutputDir(outputDir: string, opts: { force: boolean }): void {
  if (opts.force && fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
}
