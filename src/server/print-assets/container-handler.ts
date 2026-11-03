/**
 * The render half of the Cloudflare Container's HTTP service (Priority 8 /
 * Phase 3), extracted from `container/server.ts` so it can be unit-tested with
 * real Sharp and real image bytes. `container/server.ts` is then a thin
 * `node:http` shell: parse → call this → serialise.
 *
 * ⚠️  CRITICAL — same boundary rule as its neighbour `derivatives.ts`: this
 * module reaches `sharp`, a native Node addon that cannot run in the Cloudflare
 * Workers V8 isolate. It MUST only ever be imported by Node-side code (the
 * container image, the CLI, tests). NEVER from `worker.ts`'s bundle — the
 * Worker side of this pipeline talks to the container over HTTP
 * (src/server/asset-jobs/container-render.ts) precisely so it never has to.
 */

import sharp from 'sharp';
import {
  FULL_BLEED_LAYOUT,
  PRINT_RATIOS,
  assertSourceMatchesRatio,
  validateNoUpscale,
  type PrintRatio,
} from '../../lib/print-assets-prepare';
import type { DerivativeSpec } from '../asset-jobs/container-protocol';
import { composeFullBleedDerivative, type DerivativeResult } from './derivatives';

/**
 * A condition no retry can clear — bad or mislabeled input bytes. The HTTP
 * shell maps this to 422, which `classifyContainerStatus` maps to
 * `failed_action_required` (terminal, operator-actionable). Everything else
 * that throws becomes a 500 and is retried by the queue.
 */
export class PermanentInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentInputError';
  }
}

export function assertKnownRatio(value: string): PrintRatio {
  if (!(PRINT_RATIOS as readonly string[]).includes(value)) {
    throw new PermanentInputError('UNKNOWN_RATIO', `"${value}" is not a known print ratio`);
  }
  return value as PrintRatio;
}

/**
 * Decode the source, enforce every server-side limit the master plan names
 * ("Początkowy limit źródła: 100 MiB i 160 megapikseli, egzekwowany
 * serwerowo"), then produce the exact-pixel full-bleed derivative.
 *
 * Validation order is deliberate: every cheap header-level check (pixel budget,
 * declared-vs-actual ratio, would-this-upscale) runs BEFORE the expensive
 * resize, so a bad master costs a metadata read rather than a full render on a
 * container that processes one job at a time.
 *
 * Only the FULL-BLEED flow is wired up. The CMS upload contract supplies one
 * master per ratio and nothing else — no signature SVG, no
 * `PrintCompositionConfig` — which is exactly the full-bleed input shape;
 * `derivatives.ts`'s poster/compose-master flows need inputs no CMS endpoint
 * can produce yet.
 */
export async function renderFullBleedDerivative(spec: DerivativeSpec, source: Buffer): Promise<DerivativeResult> {
  const expectedRatio = assertKnownRatio(spec.expectedRatio);

  if (source.byteLength === 0) {
    throw new PermanentInputError('SOURCE_EMPTY', 'source image is empty');
  }
  if (source.byteLength > spec.maxSourceBytes) {
    throw new PermanentInputError(
      'SOURCE_TOO_LARGE',
      `source is ${source.byteLength} bytes, over the ${spec.maxSourceBytes}-byte limit`,
    );
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(source, { limitInputPixels: spec.maxSourcePixels }).metadata();
  } catch (e) {
    throw new PermanentInputError('SOURCE_UNDECODABLE', `could not decode the source image: ${String(e)}`);
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new PermanentInputError('SOURCE_UNDECODABLE', 'source image has no resolvable pixel dimensions');
  }
  if (width * height > spec.maxSourcePixels) {
    throw new PermanentInputError(
      'SOURCE_TOO_MANY_PIXELS',
      `source is ${width}x${height} (${width * height}px), over the ${spec.maxSourcePixels}px limit`,
    );
  }

  // The DECLARED ratio must match the ACTUAL pixels — guards a mislabeled or
  // swapped master (src/lib/print-assets-prepare.ts's own guard, reused rather
  // than reimplemented so the container and the CLI fail identically).
  try {
    assertSourceMatchesRatio(expectedRatio, { w: width, h: height });
  } catch (e) {
    throw new PermanentInputError('RATIO_MISMATCH', e instanceof Error ? e.message : String(e));
  }

  // Never invent resolution: a source smaller than its target (beyond the
  // documented UPSCALE_TOLERANCE) is rejected, exactly as the CLI's prepare does.
  const upscaleErrors = validateNoUpscale(FULL_BLEED_LAYOUT, spec.target, { w: width, h: height }, false);
  if (upscaleErrors.length > 0) {
    throw new PermanentInputError('WOULD_UPSCALE', upscaleErrors.join('; '));
  }

  return composeFullBleedDerivative({ sourceBuffer: source, target: spec.target, format: spec.format });
}
