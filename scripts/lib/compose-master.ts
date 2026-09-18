/**
 * CLI wrapper for print composition (Phase 0 extraction).
 *
 * This module wraps the extracted `src/server/print-assets/derivatives.ts`
 * composeMasterDerivative function, handling file I/O (loading from disk).
 * The pure Sharp composition logic lives in the extracted module.
 *
 * Pure geometry lives in src/lib/print-composition.ts and is resolved by the
 * extracted module before Sharp runs.
 */
import fs from 'node:fs';
import {
  composeMasterDerivative,
} from '../../src/server/print-assets/derivatives';
import type {
  PrintCompositionConfig,
  ComposedGeometry,
} from '../../src/lib/print-composition';
import type { DerivativeFormat } from '../../src/lib/print-assets-prepare';
import type { DerivativeResult } from './prepare-derivatives';

export interface ComposeCanvas {
  width: number;
  height: number;
}

/**
 * Compose one exact-pixel print-area derivative with full composition geometry.
 * File I/O wrapper that loads files and calls the extracted module's Buffer-based
 * implementation.
 *
 * Sharp composition and geometry resolution live in src/server/print-assets/derivatives.ts.
 */
export async function composeDerivative(
  artworkPath: string,
  signaturePath: string,
  canvas: ComposeCanvas,
  format: DerivativeFormat,
  config: PrintCompositionConfig,
): Promise<DerivativeResult & { geometry: ComposedGeometry }> {
  const artworkBuffer = fs.readFileSync(artworkPath);
  const signatureBuffer = fs.readFileSync(signaturePath);

  return composeMasterDerivative({
    artworkBuffer,
    signatureBuffer,
    canvas,
    format,
    config,
  });
}
