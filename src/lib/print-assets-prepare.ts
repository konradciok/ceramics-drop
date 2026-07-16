/**
 * Pure helpers for `scripts/print-assets-prepare.ts` (Phase 2a of the print
 * asset pipeline — docs/plans/print-asset-pipeline.md).
 *
 * No I/O, no Sharp, no filesystem — importable by the operator script and by
 * unit tests without a real image pipeline. The Sharp-touching derivative
 * generation lives in the script; this module holds the deterministic math
 * and R2-key/manifest shape the rest of the pipeline depends on.
 */

// ── R2 key ───────────────────────────────────────────────────────────────────

export type DerivativeFormat = 'jpg' | 'png';

/**
 * Content-addressed R2 key for a print-fulfilment derivative.
 * Shape fixed by supabase/migrations/20260711120000_print_fulfilment_assets.sql
 * (comment on `r2_key`): prints/{productId}/{revision}/{w}x{h}-{sha256}.{ext}
 */
export function buildR2Key(
  productId: string,
  revision: string,
  width: number,
  height: number,
  sha256: string,
  format: DerivativeFormat,
): string {
  return `prints/${productId}/${revision}/${width}x${height}-${sha256}.${format}`;
}

// ── Profile dedupe ───────────────────────────────────────────────────────────

export interface VariantDimension {
  variantKey: string;
  w: number;
  h: number;
}

export interface DerivativeProfile {
  /** `${w}x${h}` — the key used in config/print-assets/{productId}.json and the manifest. */
  profileKey: string;
  w: number;
  h: number;
  /** Every active variant_key that needs this exact dimension, in input order. */
  variantKeys: string[];
}

/**
 * Deduplicate a design's active variants by exact target dimensions.
 * Variants sharing a dimension share one derivative (plan Settled Architecture §1).
 * Profiles are returned sorted by profileKey for a stable, deterministic manifest
 * ordering independent of variant enumeration order.
 */
export function distinctProfiles(variants: VariantDimension[]): DerivativeProfile[] {
  const byProfileKey = new Map<string, DerivativeProfile>();
  for (const v of variants) {
    const profileKey = `${v.w}x${v.h}`;
    let profile = byProfileKey.get(profileKey);
    if (!profile) {
      profile = { profileKey, w: v.w, h: v.h, variantKeys: [] };
      byProfileKey.set(profileKey, profile);
    }
    profile.variantKeys.push(v.variantKey);
  }
  return [...byProfileKey.values()].sort((a, b) => a.profileKey.localeCompare(b.profileKey));
}

// ── Proportional layout (composition) ───────────────────────────────────────────

/**
 * Proportional composition rules — fractions of the target canvas, resolved to
 * concrete pixels per profile by `resolvePlacement`. Replaces the per-profile
 * `crop` model (docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md).
 *
 * Side margins are a fraction of the SHORT side (robust across portrait/
 * landscape); vertical regions are fractions of canvas height.
 */
export interface PrintLayout {
  sideMargin: number; // fraction of min(W, H), applied both sides
  topMargin: number; // fraction of H
  bottomMargin: number; // fraction of H
  gapAboveSignature: number; // fraction of H (ignored when no signature)
  signatureZoneHeight: number; // fraction of H (ignored when no signature)
  /** Optional ceiling on the artwork box width, fraction of W. */
  artworkMaxWidth?: number;
  /** Optional ceiling on the artwork box height, fraction of H. */
  artworkMaxHeight?: number;
}

/** A pixel rectangle on the canvas. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resolved placement of artwork + signature on one target canvas. */
export interface Placement {
  /** The artwork contain-target box (margins/ceilings applied). */
  artworkBox: Box;
  /** The signature zone, or null when the design has no signature. */
  signatureBox: Box | null;
  /** Contain-scaled artwork output dimensions (preserve aspect). */
  artworkOut: { width: number; height: number };
  /** Top-left canvas position of the scaled artwork (centred in available width). */
  artworkPos: { x: number; y: number };
  /** Artwork contain scale = min(boxW/srcW, boxH/srcH). Used for no-upscale validation. */
  scale: number;
}

const round = Math.round;

/**
 * Resolve a proportional layout to concrete pixel boxes on a target canvas.
 * Pure + deterministic (round-half-up). See spec §Layout model for the math.
 */
export function resolvePlacement(
  layout: PrintLayout,
  target: { w: number; h: number },
  artwork: { w: number; h: number },
  hasSignature: boolean,
): Placement {
  const { w, h } = target;
  const shortSide = Math.min(w, h);

  const mx = round(layout.sideMargin * shortSide);
  const mt = round(layout.topMargin * h);
  const mb = round(layout.bottomMargin * h);
  const gap = hasSignature ? round(layout.gapAboveSignature * h) : 0;
  const sigZone = hasSignature ? round(layout.signatureZoneHeight * h) : 0;

  const availableW = w - 2 * mx;
  const sigZoneTop = h - mb - sigZone;
  const artworkBoxTop = mt;
  const artworkBoxDerived = sigZoneTop - gap - artworkBoxTop;

  const artworkBoxW =
    layout.artworkMaxWidth != null ? Math.min(availableW, round(layout.artworkMaxWidth * w)) : availableW;
  const artworkBoxH =
    layout.artworkMaxHeight != null
      ? Math.min(artworkBoxDerived, round(layout.artworkMaxHeight * h))
      : artworkBoxDerived;

  const artworkBox: Box = { x: mx, y: artworkBoxTop, width: artworkBoxW, height: artworkBoxH };

  // Contain-fit the artwork into the box (preserve aspect, no crop).
  const scale = Math.min(artworkBoxW / artwork.w, artworkBoxH / artwork.h);
  const artworkOut = { width: round(artwork.w * scale), height: round(artwork.h * scale) };
  const artworkPos = {
    x: mx + round((availableW - artworkOut.width) / 2),
    y: artworkBoxTop + round((artworkBoxH - artworkOut.height) / 2),
  };

  const signatureBox: Box | null = hasSignature
    ? { x: mx, y: sigZoneTop, width: availableW, height: sigZone }
    : null;

  return { artworkBox, signatureBox, artworkOut, artworkPos, scale };
}

// ── Layout validation (runs before Sharp) ────────────────────────────────────

const LAYOUT_FIELDS: (keyof PrintLayout)[] = [
  'sideMargin',
  'topMargin',
  'bottomMargin',
  'gapAboveSignature',
  'signatureZoneHeight',
];

/** Every required layout fraction is a finite number in [0, 1]. Returns error strings (empty = valid). */
export function validateLayoutFractions(layout: PrintLayout): string[] {
  const errors: string[] = [];
  for (const field of LAYOUT_FIELDS) {
    const v = layout[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      errors.push(`Layout field "${field}" must be a fraction in [0, 1], got ${JSON.stringify(v)}`);
    }
  }
  for (const field of ['artworkMaxWidth', 'artworkMaxHeight'] as const) {
    const v = layout[field];
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      errors.push(`Optional layout field "${field}" must be a fraction in [0, 1] when set, got ${JSON.stringify(v)}`);
    }
  }
  return errors;
}

/**
 * The vertical stack (topMargin + artwork box + gap + signatureZone + bottomMargin)
 * must fit the canvas height for every active profile. Returns error strings.
 */
export function validateVerticalFit(
  layout: PrintLayout,
  target: { w: number; h: number },
  hasSignature: boolean,
): string[] {
  const placement = resolvePlacement(layout, target, { w: 1, h: 1 }, hasSignature);
  const errors: string[] = [];
  // artworkBox.y + height must not run past the signature zone top (or bottom margin).
  const limit = placement.signatureBox ? placement.signatureBox.y : target.h;
  if (placement.artworkBox.y + placement.artworkBox.height > limit) {
    errors.push(
      `Layout overflows canvas ${target.w}x${target.h}: artwork box bottom ` +
        `${placement.artworkBox.y + placement.artworkBox.height} exceeds limit ${limit}`,
    );
  }
  if (placement.artworkBox.height <= 0) {
    errors.push(`Layout leaves no room for artwork on canvas ${target.w}x${target.h}`);
  }
  return errors;
}

/**
 * Fail preparation when the artwork would be upscaled (contain scale > 1).
 * The artwork source must be at least as large as its box in the limiting dimension.
 */
export function validateNoUpscale(
  layout: PrintLayout,
  target: { w: number; h: number },
  artwork: { w: number; h: number },
  hasSignature: boolean,
): string[] {
  const placement = resolvePlacement(layout, target, artwork, hasSignature);
  if (placement.scale > 1) {
    return [
      `Cannot upscale artwork ${artwork.w}x${artwork.h} into box ` +
        `${placement.artworkBox.width}x${placement.artworkBox.height} on canvas ` +
        `${target.w}x${target.h} (scale ${placement.scale.toFixed(4)})`,
    ];
  }
  return [];
}

// ── Tracked config — config/print-assets/{productId}.json ──────────────────

/** Storefront gallery slot — source fulfilment profile + public/uploads stem. */
export interface GallerySlotConfig {
  sourceProfile: string;
  uploadStem: string;
}

/** Optional SVG signature layer (rendered from vector, never cut from a JPG). */
export interface SignatureConfig {
  svg: string; // path relative to repo root, under design/
}

/**
 * Product-level composition config (one layout adapts to every profile).
 * Replaces the per-profile crop map. sourceSha256/sourceWidth/sourceHeight in
 * the manifest refer to the `artwork` master named here.
 */
export interface PrepareConfig {
  product: string;
  artwork: string; // path to artwork-only master, under design/
  background: string; // hex colour, e.g. "#E8E0D7"
  format: DerivativeFormat; // product-level output format
  layout: PrintLayout;
  signature?: SignatureConfig;
  /** Optional storefront gallery slots (operator `print-assets:gallery`). */
  gallery?: Record<string, GallerySlotConfig>;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/** `format` → MIME, the exact values `print_fulfilment_assets.content_type` accepts. */
const CONTENT_TYPE_BY_FORMAT: Record<DerivativeFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
};

export interface ManifestDerivative {
  profileKey: string;
  width: number;
  height: number;
  format: DerivativeFormat;
  contentType: string;
  sha256: string;
  byteSize: number;
  r2Key: string;
  /** Resolved artwork box on this canvas (audit/repro). */
  artworkBoxPx: Box;
  /** Resolved signature zone on this canvas, or null. */
  signatureBoxPx: Box | null;
}

export interface ManifestAssignment {
  variantKey: string;
  profileKey: string;
}

/** Layout snapshot for reproducibility/audit (the operator's "layout manifest"). */
export interface ManifestLayout {
  /** Bumped on any change to the compose pipeline; gates reproducibility claims. */
  rendererVersion: string;
  background: string; // hex, as configured
  artworkSha256: string;
  signatureSha256: string | null;
  layout: PrintLayout; // the fractions, as configured
}

export interface PrepareManifest {
  product: string;
  revision: string;
  sourceSha256: string; // artwork master file hash
  sourceWidth: number; // artwork master width
  sourceHeight: number; // artwork master height
  signatureSha256: string | null; // signature.svg file hash, or null
  layout: ManifestLayout;
  derivatives: ManifestDerivative[];
  assignments: ManifestAssignment[];
}

/** Bump when the Sharp compose pipeline changes in any way that affects output bytes. */
export const COMPOSE_RENDERER_VERSION = '2.0.0';

export interface BuildManifestInput {
  product: string;
  revision: string;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  signatureSha256: string | null;
  layout: PrintLayout;
  background: string;
  hasSignature: boolean;
  profiles: DerivativeProfile[];
  /** Per-profile compose output + its resolved placement. */
  derivativeMeta: Record<
    string,
    {
      sha256: string;
      byteSize: number;
      format: DerivativeFormat;
      placement: Placement;
    }
  >;
}

export function buildManifest(input: BuildManifestInput): PrepareManifest {
  const derivatives: ManifestDerivative[] = input.profiles.map((profile) => {
    const meta = input.derivativeMeta[profile.profileKey];
    if (!meta) {
      throw new Error(`Missing derivative output for profile ${profile.profileKey}`);
    }
    return {
      profileKey: profile.profileKey,
      width: profile.w,
      height: profile.h,
      format: meta.format,
      contentType: CONTENT_TYPE_BY_FORMAT[meta.format],
      sha256: meta.sha256,
      byteSize: meta.byteSize,
      r2Key: buildR2Key(input.product, input.revision, profile.w, profile.h, meta.sha256, meta.format),
      artworkBoxPx: meta.placement.artworkBox,
      signatureBoxPx: meta.placement.signatureBox,
    };
  });

  const assignments: ManifestAssignment[] = input.profiles.flatMap((profile) =>
    profile.variantKeys.map((variantKey) => ({ variantKey, profileKey: profile.profileKey })),
  );

  return {
    product: input.product,
    revision: input.revision,
    sourceSha256: input.sourceSha256,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    signatureSha256: input.signatureSha256,
    layout: {
      rendererVersion: COMPOSE_RENDERER_VERSION,
      background: input.background,
      artworkSha256: input.sourceSha256,
      signatureSha256: input.signatureSha256,
      layout: input.layout,
    },
    derivatives,
    assignments,
  };
}

/**
 * Validate a manifest against its tracked config + its own internal consistency:
 * every configured profile has exactly one derivative, derivative dims match the
 * profile key, and each derivative's recorded artworkBoxPx equals a placement
 * recomputed from the manifest's layout + source dims. Returns error strings.
 */
export function validateManifest(manifest: PrepareManifest, config: PrepareConfig): string[] {
  const errors: string[] = [];

  for (const derivative of manifest.derivatives) {
    const [expectedW, expectedH] = derivative.profileKey.split('x').map(Number);
    if (derivative.width !== expectedW || derivative.height !== expectedH) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has dimensions ${derivative.width}x${derivative.height}, ` +
          `expected ${expectedW}x${expectedH}`,
      );
    }
    const expectedContentType = CONTENT_TYPE_BY_FORMAT[derivative.format];
    if (derivative.contentType !== expectedContentType) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has contentType "${derivative.contentType}", ` +
          `expected "${expectedContentType}" for format ${derivative.format}`,
      );
    }
    // Self-consistency: recompute the placement from the recorded layout + source dims.
    const recomputed = resolvePlacement(
      manifest.layout.layout,
      { w: derivative.width, h: derivative.height },
      { w: manifest.sourceWidth, h: manifest.sourceHeight },
      manifest.signatureSha256 != null,
    );
    if (
      recomputed.artworkBox.x !== derivative.artworkBoxPx.x ||
      recomputed.artworkBox.y !== derivative.artworkBoxPx.y ||
      recomputed.artworkBox.width !== derivative.artworkBoxPx.width ||
      recomputed.artworkBox.height !== derivative.artworkBoxPx.height
    ) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has artworkBoxPx ` +
          `${JSON.stringify(derivative.artworkBoxPx)} that does not match recomputed ` +
          `${JSON.stringify(recomputed.artworkBox)} (layout/source drift)`,
      );
    }
  }

  return errors;
}

// ── Refusal to overwrite ─────────────────────────────────────────────────────

export interface OverwriteCheck {
  exists: () => boolean;
  force?: boolean;
}

/**
 * Fail closed when the revision output directory already exists, unless the
 * operator explicitly passed --force. Avoids mixing derivatives from two
 * prepare runs under the same revision label.
 */
export function refuseOverwrite(outputDir: string, check: OverwriteCheck): void {
  if (check.force) return;
  if (check.exists()) {
    throw new Error(`Output directory already exists: ${outputDir} (pass --force to overwrite)`);
  }
}
