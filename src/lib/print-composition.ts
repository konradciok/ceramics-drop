/**
 * Pure layout math for the print composition engine
 * (docs/superpowers/specs/2026-07-15-print-composition-engine-design.md).
 *
 * No Sharp, no filesystem — importable by the operator script AND by unit tests
 * without the native Sharp binary. The Sharp-touching composition lives in
 * scripts/lib/compose-master.ts; this module holds the deterministic geometry
 * the rest of the pipeline depends on.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Per-canvas layout knobs, expressed as fractions so one config renders at every print size. */
export interface CompositionLayout {
  /** Margin as a fraction of the canvas's shorter side, clamped to [minMarginMm, maxMarginMm]. */
  marginShortSideFrac: number;
  /** Artwork max width as a fraction of canvas width. */
  artworkMaxWidthFrac: number;
  /** Artwork max height as a fraction of canvas height (already excluding the signature zone). */
  artworkMaxHeightFrac: number;
  /** Signature height as a fraction of canvas height, clamped to [minSignatureMm, maxSignatureMm]. */
  signatureHeightFrac: number;
  /** Gap between artwork bottom and signature, fraction of canvas height, clamped to [min, max]Mm. */
  signatureGapFrac: number;
  minMarginMm: number;
  maxMarginMm: number;
  minSignatureMm: number;
  maxSignatureMm: number;
  minSignatureGapMm: number;
  maxSignatureGapMm: number;
  dpi: number;
}

export interface PrintCompositionConfig {
  product: string;
  /** Path to the artwork master (gitignored design/ tree), relative to repo root. */
  artwork: string;
  /** Solid canvas background, `#rrggbb`. Defaults to #ded9c3. */
  background: string;
  /** Shared signature SVG path, relative to repo root. Signature is always horizontally centred. */
  signature: string;
  layout: CompositionLayout;
  /** Per-artwork optical-centering nudge, fractions of canvas. 0/0 = none. */
  opticalOffset: { x: number; y: number };
  /**
   * Bleed in mm, recorded in the per-asset manifest for provenance. Default 0 — the MVP
   * composes to the exact Prodigi print area (no trim/bleed rendered); set non-zero only
   * once bleed rendering lands (a layout-model change), or it would record a lie.
   */
  bleedMm: number;
}

export interface ComposedGeometry {
  canvas: { width: number; height: number };
  artwork: Rect;
  signature: Rect;
}

export const BACKGROUND_DEFAULT = '#ded9c3';

export const DEFAULT_LAYOUT: CompositionLayout = {
  marginShortSideFrac: 0.065,
  artworkMaxWidthFrac: 0.85,
  artworkMaxHeightFrac: 0.76,
  signatureHeightFrac: 0.028,
  signatureGapFrac: 0.022,
  minMarginMm: 18,
  maxMarginMm: 55,
  minSignatureMm: 8,
  maxSignatureMm: 20,
  minSignatureGapMm: 8,
  maxSignatureGapMm: 22,
  dpi: 300,
};

/** Millimetres → pixels at `dpi`, rounded to integer. */
export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

/** Clamp a pixel value into [minPx, maxPx]. */
export function clampPx(value: number, minPx: number, maxPx: number): number {
  return Math.max(minPx, Math.min(maxPx, value));
}

/** Scale (srcW, srcH) to fit inside (maxW, maxH) without cropping (CSS `contain`). */
export function containDimensions(
  srcW: number,
  srcH: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  const scale = Math.min(maxW / srcW, maxH / srcH);
  return { width: Math.round(srcW * scale), height: Math.round(srcH * scale) };
}

/**
 * Resolve the artwork + signature rectangles for one print-area canvas. The artwork
 * is `contain`-fit (always fully visible, never cropped), horizontally centred, with
 * the [artwork + gap + signature] block vertically centred inside the margin'd region.
 * `opticalOffset` nudges the artwork only — the signature stays canvas-centred.
 */
export function composeLayout(
  canvas: { width: number; height: number },
  artwork: { aspect: number },
  signature: { aspect: number },
  config: PrintCompositionConfig,
): ComposedGeometry {
  const { width: w, height: h } = canvas;
  const L = config.layout;
  const shortSide = Math.min(w, h);

  const marginPx = clampPx(
    shortSide * L.marginShortSideFrac,
    mmToPx(L.minMarginMm, L.dpi),
    mmToPx(L.maxMarginMm, L.dpi),
  );
  const sigH = clampPx(
    h * L.signatureHeightFrac,
    mmToPx(L.minSignatureMm, L.dpi),
    mmToPx(L.maxSignatureMm, L.dpi),
  );
  const sigGap = clampPx(
    h * L.signatureGapFrac,
    mmToPx(L.minSignatureGapMm, L.dpi),
    mmToPx(L.maxSignatureGapMm, L.dpi),
  );

  const availW = w - 2 * marginPx;
  const availH = h - 2 * marginPx - sigGap - sigH;
  if (availW <= 0 || availH <= 0) {
    throw new Error(`Composition margins leave no room for artwork at ${w}x${h} (margin=${marginPx}px)`);
  }

  const maxBoxW = Math.min(availW, w * L.artworkMaxWidthFrac);
  const maxBoxH = Math.min(availH, h * L.artworkMaxHeightFrac);
  const contained = containDimensions(artwork.aspect, 1, maxBoxW, maxBoxH);

  const blockH = contained.height + sigGap + sigH;
  const blockTop = marginPx + ((h - 2 * marginPx) - blockH) / 2;

  const sigW = Math.round(sigH * signature.aspect);

  // Optical offset nudges the artwork; clamp so it never leaves the canvas.
  const artW = Math.max(1, Math.min(contained.width, w));
  const artH = Math.max(1, Math.min(contained.height, h));
  const artLeft = Math.round(
    clampPx((w - artW) / 2 + config.opticalOffset.x * w, 0, w - artW),
  );
  const artTop = Math.round(clampPx(blockTop + config.opticalOffset.y * h, 0, h - artH));

  return {
    canvas: { width: w, height: h },
    artwork: { left: artLeft, top: artTop, width: artW, height: artH },
    signature: {
      left: Math.round((w - sigW) / 2),
      top: Math.round(blockTop + artH + sigGap),
      width: sigW,
      height: sigH,
    },
  };
}

/** Pixels → millimetres at `dpi`, rounded to integer (inverse of `mmToPx`). */
export function pxToMm(px: number, dpi: number): number {
  return Math.round((px / dpi) * 25.4);
}

/**
 * Composition-engine version — bump whenever the layout math changes. Stamped into
 * each per-asset manifest (req. 16) so a derivative records which renderer produced it.
 */
export const RENDERER_VERSION = '1.0.0';

/** Per-asset layout provenance record (req. 16). Local-only; never uploaded. */
export interface AssetManifest {
  canvasMm: { width: number; height: number };
  dpi: number;
  bleedMm: number;
  artworkBoxPx: { x: number; y: number; width: number; height: number };
  signatureBoxPx: { x: number; y: number; width: number; height: number };
  background: string;
  sourceHash: string;
  rendererVersion: string;
}

/**
 * Build the per-asset layout manifest from a resolved `ComposedGeometry` (req. 16) —
 * records exactly how the canvas was composed so a derivative is reproducible/auditable
 * on its own. Every field is derived: geometry → boxes/canvas mm, config → dpi/background/bleed.
 */
export function buildAssetManifest(
  geo: ComposedGeometry,
  config: PrintCompositionConfig,
  sourceHash: string,
): AssetManifest {
  const dpi = config.layout.dpi;
  const box = (r: Rect): { x: number; y: number; width: number; height: number } => ({
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height,
  });
  return {
    canvasMm: { width: pxToMm(geo.canvas.width, dpi), height: pxToMm(geo.canvas.height, dpi) },
    dpi,
    bleedMm: config.bleedMm,
    artworkBoxPx: box(geo.artwork),
    signatureBoxPx: box(geo.signature),
    background: config.background,
    sourceHash: `sha256:${sourceHash}`,
    rendererVersion: RENDERER_VERSION,
  };
}
