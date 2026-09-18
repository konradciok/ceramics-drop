/**
 * CLI wrapper for derivative generation (Phase 0 extraction).
 *
 * This module wraps the extracted `src/server/print-assets/derivatives.ts` module,
 * handling file I/O (loading from disk, validation, writing to disk).
 * The pure Sharp composition logic lives in the extracted module, which the CLI
 * calls after loading files into Buffers.
 *
 * Pure placement math lives in src/lib/print-assets-prepare.ts and is
 * validated by the caller (the script) before this module runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { DerivativeFormat, Placement } from '../../src/lib/print-assets-prepare';
import {
  composePrepareDerivative,
  composeFullBleedDerivative as composeFullBleedBuffer,
  signatureDensity,
  rasterizeSignature as rasterizeSignatureBuffer,
} from '../../src/server/print-assets/derivatives';

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

// Re-export these from the extracted module for backward compatibility
export { signatureDensity };

/**
 * Rasterise a signature SVG from a file path at a bounded contain-scale density,
 * then resize (letterboxed, transparent background) into the exact target zone.
 *
 * File I/O wrapper around the extracted module's Buffer-based rasterizeSignature.
 */
export async function rasterizeSignature(
  signatureSvgPath: string,
  zone: { width: number; height: number },
): Promise<Buffer> {
  const svgBuffer = fs.readFileSync(signatureSvgPath);
  return rasterizeSignatureBuffer(svgBuffer, zone);
}

/**
 * Compose one exact-pixel Prodigi derivative by layering the artwork master and
 * (optionally) an SVG signature onto a solid background canvas. File I/O wrapper
 * that loads files and calls the extracted module's Buffer-based implementation.
 *
 * Pure layout math and Sharp composition logic live in src/server/print-assets/derivatives.ts.
 */
export async function composeDerivative(input: ComposeInput): Promise<DerivativeResult> {
  const { artworkPath, signatureSvgPath, background, placement, target, format } = input;

  // Load files into Buffers and delegate to the extracted module
  const artworkBuffer = fs.readFileSync(artworkPath);
  const signatureSvgBuffer = signatureSvgPath ? fs.readFileSync(signatureSvgPath) : null;

  return composePrepareDerivative({
    artworkBuffer,
    signatureSvgBuffer,
    background,
    placement,
    target,
    format,
  });
}

/**
 * Compose one exact-pixel full-bleed derivative: a plain resize of the source
 * to exact target pixels. File I/O wrapper that loads the file and calls the
 * extracted module's Buffer-based implementation.
 *
 * The caller has already validated no upscale is required, so `fit: 'fill'`
 * here only ever applies negligible (<=0.5%) correction tolerance.
 */
export async function composeFullBleedDerivative(input: {
  sourcePath: string;
  target: { w: number; h: number };
  format: DerivativeFormat;
}): Promise<DerivativeResult> {
  const { sourcePath, target, format } = input;

  const sourceBuffer = fs.readFileSync(sourcePath);
  return composeFullBleedBuffer({
    sourceBuffer,
    target,
    format,
  });
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
