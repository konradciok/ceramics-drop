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

  const artworkBoxX = mx + round((availableW - artworkBoxW) / 2);
  const artworkBox: Box = { x: artworkBoxX, y: artworkBoxTop, width: artworkBoxW, height: artworkBoxH };

  // Contain-fit the artwork into the box (preserve aspect, no crop).
  const scale = Math.min(artworkBoxW / artwork.w, artworkBoxH / artwork.h);
  const artworkOut = { width: round(artwork.w * scale), height: round(artwork.h * scale) };
  const artworkPos = {
    x: artworkBoxX + round((artworkBoxW - artworkOut.width) / 2),
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

/** Ensure the resolved artwork and optional signature boxes are usable and remain inside the canvas. */
export function validatePlacementFit(
  layout: PrintLayout,
  target: { w: number; h: number },
  hasSignature: boolean,
): string[] {
  if (!Number.isInteger(target.w) || !Number.isInteger(target.h) || target.w <= 0 || target.h <= 0) {
    return [`Target canvas must have positive integer dimensions, got ${target.w}x${target.h}`];
  }

  const placement = resolvePlacement(layout, target, { w: 1, h: 1 }, hasSignature);
  const errors = validateVerticalFit(layout, target, hasSignature);
  const artwork = placement.artworkBox;

  if (artwork.width <= 0) {
    errors.push(`Layout leaves no horizontal room for artwork on canvas ${target.w}x${target.h}`);
  }
  if (artwork.x < 0 || artwork.x + artwork.width > target.w) {
    errors.push(
      `Artwork box ${JSON.stringify(artwork)} exceeds horizontal bounds of canvas ${target.w}x${target.h}`,
    );
  }
  if (artwork.y < 0 || artwork.y + artwork.height > target.h) {
    errors.push(`Artwork box ${JSON.stringify(artwork)} exceeds canvas ${target.w}x${target.h}`);
  }

  const signature = placement.signatureBox;
  if (signature) {
    if (signature.width <= 0 || signature.height <= 0) {
      errors.push(`Layout leaves no room for the signature on canvas ${target.w}x${target.h}`);
    }
    if (
      signature.x < 0 ||
      signature.y < 0 ||
      signature.x + signature.width > target.w ||
      signature.y + signature.height > target.h
    ) {
      errors.push(`Signature box ${JSON.stringify(signature)} exceeds canvas ${target.w}x${target.h}`);
    }
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

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the untrusted JSON config before any filesystem, Supabase, or Sharp
 * work. TypeScript's `PrepareConfig` type does not protect the operator CLI at
 * runtime because the file is parsed from JSON.
 */
export function validatePrepareConfig(value: unknown, expectedProduct?: string): string[] {
  if (!isRecord(value)) return ['Prepare config must be a JSON object'];

  const errors: string[] = [];
  if (typeof value.product !== 'string' || value.product.trim() === '') {
    errors.push('Config field "product" must be a non-empty string');
  } else if (expectedProduct && value.product !== expectedProduct) {
    errors.push(`Config declares product "${value.product}", expected "${expectedProduct}"`);
  }
  if (typeof value.artwork !== 'string' || value.artwork.trim() === '') {
    errors.push('Config field "artwork" must be a non-empty path');
  }
  if (typeof value.background !== 'string' || !HEX_COLOUR.test(value.background)) {
    errors.push(`Config field "background" must be an exact #RRGGBB colour, got ${JSON.stringify(value.background)}`);
  }
  if (value.format !== 'jpg' && value.format !== 'png') {
    errors.push(`Config field "format" must be "jpg" or "png", got ${JSON.stringify(value.format)}`);
  }
  if (!isRecord(value.layout)) {
    errors.push('Config field "layout" must be an object');
  } else {
    errors.push(...validateLayoutFractions(value.layout as unknown as PrintLayout));
  }
  if (value.signature != null) {
    if (!isRecord(value.signature) || typeof value.signature.svg !== 'string' || value.signature.svg.trim() === '') {
      errors.push('Config field "signature.svg" must be a non-empty path when signature is configured');
    }
  }
  return errors;
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
  /** Actual rendered artwork rectangle on this canvas (audit/repro). */
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
      artworkBoxPx: {
        x: meta.placement.artworkPos.x,
        y: meta.placement.artworkPos.y,
        width: meta.placement.artworkOut.width,
        height: meta.placement.artworkOut.height,
      },
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

  if (manifest.product !== config.product) {
    errors.push(`Manifest product "${manifest.product}" does not match config product "${config.product}"`);
  }
  if (manifest.layout.rendererVersion !== COMPOSE_RENDERER_VERSION) {
    errors.push(
      `Manifest rendererVersion "${manifest.layout.rendererVersion}" does not match "${COMPOSE_RENDERER_VERSION}"`,
    );
  }
  if (manifest.layout.background !== config.background) {
    errors.push(
      `Manifest background "${manifest.layout.background}" does not match config background "${config.background}"`,
    );
  }
  if (JSON.stringify(manifest.layout.layout) !== JSON.stringify(config.layout)) {
    errors.push('Manifest layout does not match the tracked config layout');
  }
  if (manifest.layout.artworkSha256 !== manifest.sourceSha256) {
    errors.push('Manifest artwork hash does not match sourceSha256');
  }
  if (manifest.layout.signatureSha256 !== manifest.signatureSha256) {
    errors.push('Manifest signature hashes are inconsistent');
  }
  if ((manifest.signatureSha256 != null) !== (config.signature != null)) {
    errors.push('Manifest signature presence does not match the tracked config');
  }

  const profileKeys = new Set<string>();

  for (const derivative of manifest.derivatives) {
    if (profileKeys.has(derivative.profileKey)) {
      errors.push(`Manifest contains duplicate derivative profile ${derivative.profileKey}`);
    }
    profileKeys.add(derivative.profileKey);

    const profileMatch = /^(\d+)x(\d+)$/.exec(derivative.profileKey);
    const expectedW = profileMatch ? Number(profileMatch[1]) : Number.NaN;
    const expectedH = profileMatch ? Number(profileMatch[2]) : Number.NaN;
    if (!profileMatch || expectedW <= 0 || expectedH <= 0) {
      errors.push(`Derivative profileKey "${derivative.profileKey}" must be positive dimensions in WxH form`);
      continue;
    }
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
    if (derivative.format !== config.format) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} uses format ${derivative.format}, expected ${config.format}`,
      );
    }
    const expectedR2Key = buildR2Key(
      manifest.product,
      manifest.revision,
      derivative.width,
      derivative.height,
      derivative.sha256,
      derivative.format,
    );
    if (derivative.r2Key !== expectedR2Key) {
      errors.push(`Derivative for profile ${derivative.profileKey} has an inconsistent r2Key`);
    }
    // Self-consistency: recompute the placement from the recorded layout + source dims.
    const recomputed = resolvePlacement(
      manifest.layout.layout,
      { w: derivative.width, h: derivative.height },
      { w: manifest.sourceWidth, h: manifest.sourceHeight },
      manifest.signatureSha256 != null,
    );
    const renderedArtworkBox: Box = {
      x: recomputed.artworkPos.x,
      y: recomputed.artworkPos.y,
      width: recomputed.artworkOut.width,
      height: recomputed.artworkOut.height,
    };
    if (
      renderedArtworkBox.x !== derivative.artworkBoxPx.x ||
      renderedArtworkBox.y !== derivative.artworkBoxPx.y ||
      renderedArtworkBox.width !== derivative.artworkBoxPx.width ||
      renderedArtworkBox.height !== derivative.artworkBoxPx.height
    ) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has artworkBoxPx ` +
          `${JSON.stringify(derivative.artworkBoxPx)} that does not match recomputed ` +
          `${JSON.stringify(renderedArtworkBox)} (layout/source drift)`,
      );
    }
    if (JSON.stringify(recomputed.signatureBox) !== JSON.stringify(derivative.signatureBoxPx)) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has signatureBoxPx ` +
          `${JSON.stringify(derivative.signatureBoxPx)} that does not match recomputed ` +
          `${JSON.stringify(recomputed.signatureBox)} (layout/source drift)`,
      );
    }
  }

  const assignedVariants = new Set<string>();
  for (const assignment of manifest.assignments) {
    if (assignedVariants.has(assignment.variantKey)) {
      errors.push(`Manifest contains duplicate assignment for variant ${assignment.variantKey}`);
    }
    assignedVariants.add(assignment.variantKey);
    if (!profileKeys.has(assignment.profileKey)) {
      errors.push(
        `Assignment for variant ${assignment.variantKey} references missing profile ${assignment.profileKey}`,
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
