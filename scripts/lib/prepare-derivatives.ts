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

// Baseline DPI Sharp/librsvg use to resolve an SVG's unitless intrinsic size.
const BASE_SVG_DPI = 72;
// Hard ceiling on the density we'll ever ask librsvg to rasterise at.
const MAX_SVG_DENSITY = 2400;
// Hard ceiling on the resulting raster pixel count (decode-time memory).
const MAX_SIGNATURE_RASTER_PIXELS = 50_000_000;

/**
 * DPI that contain-scales a signature SVG's intrinsic size up to its target
 * zone — never below the 72dpi baseline (no downscaling below source
 * resolution), and never past a fixed density/pixel budget. Decoding a small
 * signature at 72dpi and letting `.resize()` upscale the raster afterwards
 * produces a blurry result on large canvases; deriving the density up front
 * and asking librsvg to rasterise at that density directly keeps edges crisp
 * without an unbounded (memory-blowing) decode on a huge zone.
 */
export function signatureDensity(
  zone: { width: number; height: number },
  intrinsic: { width: number; height: number },
): number {
  if (
    !Number.isFinite(zone.width) ||
    !Number.isFinite(zone.height) ||
    zone.width <= 0 ||
    zone.height <= 0
  ) {
    throw new Error(`Invalid signature zone ${zone.width}x${zone.height}`);
  }
  if (
    !Number.isFinite(intrinsic.width) ||
    !Number.isFinite(intrinsic.height) ||
    intrinsic.width <= 0 ||
    intrinsic.height <= 0
  ) {
    throw new Error(`Signature SVG has invalid intrinsic dimensions ${intrinsic.width}x${intrinsic.height}`);
  }
  const containScale = Math.max(
    1,
    Math.min(zone.width / intrinsic.width, zone.height / intrinsic.height),
  );
  const density = Math.ceil(BASE_SVG_DPI * containScale);
  const rasterWidth = Math.ceil((intrinsic.width * density) / BASE_SVG_DPI);
  const rasterHeight = Math.ceil((intrinsic.height * density) / BASE_SVG_DPI);
  if (density > MAX_SVG_DENSITY || rasterWidth * rasterHeight > MAX_SIGNATURE_RASTER_PIXELS) {
    throw new Error(
      `Signature SVG exceeds the safe density budget: ${density}dpi, ${rasterWidth}x${rasterHeight}px`,
    );
  }
  return density;
}

/**
 * Rasterise a signature SVG at a bounded contain-scale density, then resize
 * (letterboxed, transparent background) into the exact target zone.
 */
export async function rasterizeSignature(
  signatureSvgPath: string,
  zone: { width: number; height: number },
): Promise<Buffer> {
  const metadata = await sharp(signatureSvgPath, { density: BASE_SVG_DPI }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Signature SVG has no resolvable intrinsic pixel dimensions: ${signatureSvgPath}`);
  }
  const density = signatureDensity(zone, { width: metadata.width, height: metadata.height });
  return sharp(signatureSvgPath, {
    density,
    limitInputPixels: MAX_SIGNATURE_RASTER_PIXELS,
    unlimited: false,
  })
    .resize(zone.width, zone.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();
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

  // 3. Signature: rasterise the SVG at a bounded contain-scale density into its
  // zone (never blurry-upscaled, never an unbounded decode), place centred in the zone.
  if (signatureSvgPath && placement.signatureBox) {
    const zone = placement.signatureBox;
    const sigLayer = await rasterizeSignature(signatureSvgPath, zone);
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
 * Prepare a clean revision output directory, failing closed on an existing one.
 * Without `--force` an existing directory throws (never mix derivatives from two
 * prepare runs under the same revision label); with `--force` it is removed
 * first — otherwise a re-run with a different layout config can leave stale
 * `{profile}-{oldSha256}.{ext}` files beside a `manifest.json` that no longer
 * references them, which is confusing for Phase 2b's upload/verify step.
 */
export function prepareOutputDir(outputDir: string, options: { force: boolean }): void {
  if (fs.existsSync(outputDir)) {
    if (!options.force) throw new Error(`Output directory already exists: ${outputDir} (pass --force to overwrite)`);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
}
