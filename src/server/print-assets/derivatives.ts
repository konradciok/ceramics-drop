/**
 * Sharp-based derivative generation, extracted from scripts/lib/ into a
 * pure module that the future Container and CLI both use.
 *
 * ⚠️  CRITICAL: This module depends on `sharp` — a native Node.js addon that
 * cannot run in the Cloudflare Workers V8 isolate. This module MUST ONLY be
 * called from Node-side code (the CLI today, the Cloudflare Container in Phase 1).
 * NEVER import or call this from anything `worker.ts` bundles into the runtime.
 *
 * Takes Buffers and metadata objects instead of file paths, so it can run
 * in environments without a local filesystem (the Cloudflare Container in Phase 1).
 *
 * Deterministic Sharp pipelines for Prodigi print-asset derivatives:
 * - prepare-derivatives flow: artwork + optional signature composition
 * - compose-master flow: full print-area composition with geometry
 */

import crypto from 'node:crypto';
import sharp from 'sharp';
import type { DerivativeFormat, Placement } from '../../lib/print-assets-prepare';
import type { PrintCompositionConfig, ComposedGeometry } from '../../lib/print-composition';
import { composeLayout } from '../../lib/print-composition';

// ── Shared types ──────────────────────────────────────────────────────────

export interface DerivativeResult {
  sha256: string;
  byteSize: number;
  format: DerivativeFormat;
  buffer: Buffer;
}

// ── Signature density (pure math) ──────────────────────────────────────────

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
 * Rasterise a signature SVG buffer at a bounded contain-scale density, then resize
 * (letterboxed, transparent background) into the exact target zone.
 *
 * Takes an SVG Buffer (e.g., loaded from disk or S3) instead of a file path.
 */
export async function rasterizeSignature(
  svgBuffer: Buffer,
  zone: { width: number; height: number },
): Promise<Buffer> {
  const metadata = await sharp(svgBuffer, { density: BASE_SVG_DPI }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Signature SVG has no resolvable intrinsic pixel dimensions`);
  }
  const density = signatureDensity(zone, { width: metadata.width, height: metadata.height });
  return sharp(svgBuffer, {
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
 * fixed input buffer + placement → byte-identical output across runs. Sharp
 * colour-manages artwork into sRGB; `.withMetadata()` embeds the output sRGB
 * profile so the configured RGB background and artwork share one declared
 * colour space.
 *
 * An RGBA artwork master is acceptable here (unlike the old crop path): alpha
 * composites onto the configured opaque background, and the output is flattened —
 * no transparency reaches Prodigi.
 *
 * Takes Buffers (e.g., from S3 or memory) instead of file paths.
 */
export async function composePrepareDerivative(input: {
  artworkBuffer: Buffer;
  signatureSvgBuffer: Buffer | null;
  background: string; // hex "#RRGGBB"
  placement: Placement; // from resolvePlacement (src/lib/print-assets-prepare.ts)
  target: { w: number; h: number };
  format: DerivativeFormat;
}): Promise<DerivativeResult> {
  const { artworkBuffer, signatureSvgBuffer, background, placement, target, format } = input;

  // 1. Base canvas = exact target pixels, filled with the configured background.
  const canvas = sharp({
    create: { width: target.w, height: target.h, channels: 3, background },
  });

  // 2. Artwork: resize to the contain-computed output dims and place centred in its box.
  const artworkLayer = await sharp(artworkBuffer)
    .resize(placement.artworkOut.width, placement.artworkOut.height, { fit: 'fill' })
    .toBuffer();

  const overlays: sharp.OverlayOptions[] = [
    { input: artworkLayer, left: placement.artworkPos.x, top: placement.artworkPos.y },
  ];

  // 3. Signature: rasterise the SVG at a bounded contain-scale density into its
  // zone (never blurry-upscaled, never an unbounded decode), place centred in the zone.
  if (signatureSvgBuffer && placement.signatureBox) {
    const zone = placement.signatureBox;
    const sigLayer = await rasterizeSignature(signatureSvgBuffer, zone);
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

/**
 * Compose one exact-pixel full-bleed derivative: a plain resize of the
 * per-ratio master to the exact target pixels — no background canvas, no
 * overlay, no crop. The caller has already validated the source's ratio matches
 * its assigned profile ratio and that no upscale is required
 * (src/lib/print-assets-prepare.ts `assertSourceMatchesRatio` / `validateNoUpscale`),
 * so `fit: 'fill'` here only ever applies the negligible (<=0.5%) correction that
 * tolerance allows — never a real crop or letterbox. Lanczos3 kernel per plan;
 * sRGB embedded via `.withMetadata()`.
 *
 * Takes a Buffer instead of a file path.
 */
export async function composeFullBleedDerivative(input: {
  sourceBuffer: Buffer;
  target: { w: number; h: number };
  format: DerivativeFormat;
}): Promise<DerivativeResult> {
  const { sourceBuffer, target, format } = input;

  let pipeline = sharp(sourceBuffer)
    .resize(target.w, target.h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .toColourspace('srgb')
    .removeAlpha()
    .withMetadata();

  if (format === 'jpg') {
    pipeline = pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false });
  }

  const buffer = await pipeline.toBuffer();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return { sha256, byteSize: buffer.byteLength, format, buffer };
}

// ── Compose-master flow ────────────────────────────────────────────────────

/**
 * Parse and validate a background colour hex code.
 */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid background colour "${hex}" — expected #rrggbb`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Compose one exact-pixel print-area derivative with full geometry (print composition).
 * Takes artwork and signature Buffers (not file paths), decodes their aspect ratios,
 * resolves the composition geometry, and returns the composite result along with
 * the computed geometry for the manifest.
 *
 * Deterministic (fixed JPEG quality, no encoder jitter) and embeds the sRGB ICC
 * profile so the file Prodigi receives isn't unprofiled.
 */
export async function composeMasterDerivative(input: {
  artworkBuffer: Buffer;
  signatureBuffer: Buffer;
  canvas: { width: number; height: number };
  format: DerivativeFormat;
  config: PrintCompositionConfig;
}): Promise<DerivativeResult & { geometry: ComposedGeometry }> {
  const { artworkBuffer, signatureBuffer, canvas, format, config } = input;

  // Decode aspect ratios from buffers
  const artMeta = await sharp(artworkBuffer).metadata();
  const artAspect = (artMeta.width ?? 0) / (artMeta.height ?? 1);
  if (!artAspect || !Number.isFinite(artAspect)) {
    throw new Error(`Could not read artwork dimensions (ensure the image is decodable)`);
  }

  const sigMeta = await sharp(signatureBuffer).metadata();
  const sigAspect = (sigMeta.width ?? 0) / (sigMeta.height ?? 1);
  if (!sigAspect || !Number.isFinite(sigAspect)) {
    throw new Error(
      `Could not read signature dimensions (ensure the SVG has a viewBox)`
    );
  }

  // Resolve composition geometry
  const geo = composeLayout(canvas, { aspect: artAspect }, { aspect: sigAspect }, config);
  const background = parseHex(config.background);

  // Compose layers
  const artworkLayer = await sharp(artworkBuffer)
    .resize(geo.artwork.width, geo.artwork.height, { fit: 'fill' })
    .toBuffer();
  const signatureLayer = await sharp(signatureBuffer)
    .resize(geo.signature.width, geo.signature.height, { fit: 'fill' })
    .toBuffer();

  let pipeline = sharp({
    create: { width: canvas.width, height: canvas.height, channels: 3, background },
  })
    .composite([
      { input: artworkLayer, left: geo.artwork.left, top: geo.artwork.top },
      { input: signatureLayer, left: geo.signature.left, top: geo.signature.top },
    ])
    .withMetadata({ icc: 'srgb' }); // embed sRGB so the file isn't unprofiled

  // The base canvas is opaque (channels:3); flatten is a no-op safety net
  // so a stray alpha never reaches a JPG bound for Prodigi.
  if (format === 'jpg') {
    pipeline = pipeline
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false });
  }

  const buffer = await pipeline.toBuffer();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return { sha256, byteSize: buffer.byteLength, format, buffer, geometry: geo };
}
