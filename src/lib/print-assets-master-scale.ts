/**
 * Pre-`prepare` artwork master sizing — answers "is this master big enough,
 * and if not, by what factor must it be upscaled?" for every active print
 * profile of a product, before Sharp ever touches it.
 *
 * `validateNoUpscale` (print-assets-prepare.ts) only reports pass/fail at the
 * CURRENT source size. This module reuses the same `resolvePlacement` contain-
 * scale math to answer the inverse question an operator asks before a source
 * even exists at full size: how much upscale (via an external tool — this
 * pipeline's `prepare` step never upscales, see docs/plans/print-asset-pipeline.md
 * "Explicit Non-Goals") does a given master need, and what should the final
 * pixel dimensions be.
 */
import { resolvePlacement, type PrintLayout } from './print-assets-prepare';

export interface ProfileScale {
  profileKey: string;
  /** Contain-scale `resolvePlacement` would apply at the given source size. >1 means upscale needed. */
  scale: number;
  /** The profile's artwork box — independent of source size, the hard floor for that profile alone. */
  box: { width: number; height: number };
}

/**
 * Per-profile contain-scale + box for a candidate (or hypothetical) source
 * size. `source` may be a real master's decoded dimensions, or `{w:1,h:1}`
 * to inspect only the source-independent `box` sizes (e.g. before a master
 * exists at all).
 */
export function masterScaleReport(
  layout: PrintLayout,
  profiles: readonly { profileKey: string; w: number; h: number }[],
  source: { w: number; h: number },
  hasSignature: boolean,
): ProfileScale[] {
  return profiles.map((profile) => {
    const placement = resolvePlacement(layout, { w: profile.w, h: profile.h }, source, hasSignature);
    return {
      profileKey: profile.profileKey,
      scale: placement.scale,
      box: { width: placement.artworkBox.width, height: placement.artworkBox.height },
    };
  });
}

/** The single scale factor a master must be upscaled by to satisfy every profile at once. */
export function requiredMasterScale(report: readonly ProfileScale[]): number {
  return report.reduce((max, p) => Math.max(max, p.scale), 1);
}

/**
 * Target pixel dimensions after upscaling `source` by `scale`, with an
 * optional headroom multiplier (e.g. 1.05 for a 5% buffer against rounding
 * and future profile additions). Preserves the source's aspect ratio.
 */
export function targetMasterDimensions(
  source: { w: number; h: number },
  scale: number,
  headroom = 1,
): { width: number; height: number } {
  return {
    width: Math.ceil(source.w * scale * headroom),
    height: Math.ceil(source.h * scale * headroom),
  };
}
