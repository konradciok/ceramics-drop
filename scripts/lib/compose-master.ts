/**
 * Sharp composition for `scripts/print-assets-compose.ts`.
 *
 * The ONLY new module that touches Sharp for composition. Lives under scripts/lib/
 * (not src/lib/) — Sharp is a native binding incompatible with the Cloudflare
 * Workers runtime that src/lib/ bundles into (mirrors prepare-derivatives.ts).
 *
 * Pure geometry lives in src/lib/print-composition.ts and is resolved by this
 * module before Sharp runs.
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  composeLayout,
  type PrintCompositionConfig,
  type ComposedGeometry,
} from '../../src/lib/print-composition';
import type { DerivativeFormat } from '../../src/lib/print-assets-prepare';
import type { DerivativeResult } from './prepare-derivatives';

export interface ComposeCanvas {
  width: number;
  height: number;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid background colour "${hex}" — expected #rrggbb`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

async function resizedLayer(srcPath: string, width: number, height: number): Promise<Buffer> {
  return sharp(srcPath).resize(width, height, { fit: 'fill' }).toBuffer();
}

async function aspectOf(srcPath: string, label: string): Promise<number> {
  const meta = await sharp(srcPath).metadata();
  const aspect = (meta.width ?? 0) / (meta.height ?? 1);
  if (!aspect || !Number.isFinite(aspect)) {
    throw new Error(`Could not read ${label} dimensions from ${srcPath}${label === 'signature' ? ' (ensure the SVG has a viewBox)' : ''}`);
  }
  return aspect;
}

/**
 * Compose one exact-pixel print-area derivative: #ded9c3 (or configured) background
 * fill → artwork `contain`-fit (always fully visible) → centred signature. Deterministic
 * (fixed JPEG quality, no encoder jitter) and embeds the sRGB ICC profile so the file
 * Prodigi receives isn't unprofiled.
 */
export async function composeDerivative(
  artworkPath: string,
  signaturePath: string,
  canvas: ComposeCanvas,
  format: DerivativeFormat,
  config: PrintCompositionConfig,
): Promise<DerivativeResult & { geometry: ComposedGeometry }> {
  const artAspect = await aspectOf(artworkPath, 'artwork');
  const sigAspect = await aspectOf(signaturePath, 'signature');

  const geo = composeLayout(canvas, { aspect: artAspect }, { aspect: sigAspect }, config);
  const background = parseHex(config.background);

  const artworkLayer = await resizedLayer(artworkPath, geo.artwork.width, geo.artwork.height);
  const signatureLayer = await resizedLayer(signaturePath, geo.signature.width, geo.signature.height);

  let pipeline = sharp({
    create: { width: canvas.width, height: canvas.height, channels: 3, background },
  })
    .composite([
      { input: artworkLayer, left: geo.artwork.left, top: geo.artwork.top },
      { input: signatureLayer, left: geo.signature.left, top: geo.signature.top },
    ])
    .withMetadata({ icc: 'srgb' }); // embed sRGB so the file isn't unprofiled

  // The base canvas is opaque (channels:3); flatten is a no-op safety net matching
  // prepare-derivatives so a stray alpha never reaches a JPG bound for Prodigi.
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
