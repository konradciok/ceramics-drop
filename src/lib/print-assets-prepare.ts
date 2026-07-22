/**
 * Pure helpers for `scripts/print-assets-prepare.ts` (Phase 2a of the print
 * asset pipeline — docs/plans/print-asset-pipeline.md).
 *
 * No I/O, no Sharp, no filesystem — importable by the operator script and by
 * unit tests without a real image pipeline. The Sharp-touching derivative
 * generation lives in the script; this module holds the deterministic math
 * and R2-key/manifest shape the rest of the pipeline depends on.
 */
import { z } from 'zod';

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
 * Validate a resolved placement against its target canvas: positive integer
 * canvas dimensions, positive artwork/signature boxes, and every box fully
 * inside the canvas. Returns error strings (empty = valid).
 *
 * Consolidates the old validateVerticalFit + validatePlacementFit split — the
 * resolved boxes already carry the geometry those two used to recompute, so
 * both the prepare script (per profile) and the manifest parser (per recomputed
 * derivative) share one bounds check.
 */
export function validatePlacement(placement: Placement, target: { w: number; h: number }): string[] {
  if (!Number.isInteger(target.w) || !Number.isInteger(target.h) || target.w <= 0 || target.h <= 0) {
    return [`Target canvas must have positive integer dimensions, got ${target.w}x${target.h}`];
  }

  const errors: string[] = [];
  const check = (label: string, box: Box): void => {
    if (box.width <= 0 || box.height <= 0) {
      errors.push(
        `${label} box ${JSON.stringify(box)} must have positive dimensions on canvas ${target.w}x${target.h}`,
      );
      return;
    }
    if (box.x < 0 || box.y < 0 || box.x + box.width > target.w || box.y + box.height > target.h) {
      errors.push(`${label} box ${JSON.stringify(box)} exceeds the canvas bounds ${target.w}x${target.h}`);
    }
  };

  check('Artwork', placement.artworkBox);
  if (placement.signatureBox) check('Signature', placement.signatureBox);
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

// ── Manifest schema v2 ─────────────────────────────────────────────────────

/** Bump when the Sharp compose pipeline changes in any way that affects output bytes. */
export const COMPOSE_RENDERER_VERSION = '2.1.0';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const safeSegmentSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const repoRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((segment) => safeSegmentSchema.safeParse(segment).success),
    'Expected a normalized repository-relative POSIX path',
  );
const formatSchema = z.enum(['jpg', 'png']);
const boxSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const layoutSchema = z
  .object({
    sideMargin: z.number().finite().min(0).max(1),
    topMargin: z.number().finite().min(0).max(1),
    bottomMargin: z.number().finite().min(0).max(1),
    gapAboveSignature: z.number().finite().min(0).max(1),
    signatureZoneHeight: z.number().finite().min(0).max(1),
    artworkMaxWidth: z.number().finite().min(0).max(1).optional(),
    artworkMaxHeight: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
const derivativeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: formatSchema,
    sha256: sha256Schema,
    byteSize: z.number().int().positive(),
    artworkBoxPx: boxSchema,
    signatureBoxPx: boxSchema.nullable(),
  })
  .strict();
const assignmentSchema = z
  .object({
    variantKey: z.string().min(1),
    profileKey: z.string().regex(/^[1-9]\d*x[1-9]\d*$/),
  })
  .strict();

/**
 * Strict schema-v2 manifest. Every fact is stored exactly once: the derived
 * `profileKey` / `contentType` / `r2Key` a derivative used to carry are recomputed
 * from dimensions, format, hash, product, and revision by the consumers.
 */
export const prepareManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    product: safeSegmentSchema,
    revision: safeSegmentSchema,
    rendererVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    configSha256: sha256Schema,
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    layout: layoutSchema,
    artwork: z
      .object({
        path: repoRelativePathSchema,
        sha256: sha256Schema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    signature: z.object({ path: repoRelativePathSchema, sha256: sha256Schema }).strict().nullable(),
    derivatives: z.array(derivativeSchema).min(1),
    assignments: z.array(assignmentSchema).min(1),
  })
  .strict();

export type PrepareManifest = z.infer<typeof prepareManifestSchema>;
export type ManifestDerivative = PrepareManifest['derivatives'][number];
export type ManifestAssignment = PrepareManifest['assignments'][number];

/** Matches DB `profile_key` and legacy manifest profile keys. */
export function profileKeyFromPx(width: number, height: number): string {
  return `${width}x${height}`;
}

/** `format` → MIME, the exact values `print_fulfilment_assets.content_type` accepts. */
export function contentTypeForFormat(format: DerivativeFormat): 'image/jpeg' | 'image/png' {
  return format === 'jpg' ? 'image/jpeg' : 'image/png';
}

/** Content-addressed R2 key for a v2 derivative, derived from its immutable facts. */
export function derivativeR2Key(
  manifest: Pick<PrepareManifest, 'product' | 'revision'>,
  derivative: Pick<ManifestDerivative, 'width' | 'height' | 'sha256' | 'format'>,
): string {
  return buildR2Key(
    manifest.product,
    manifest.revision,
    derivative.width,
    derivative.height,
    derivative.sha256,
    derivative.format,
  );
}

function boxesEqual(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Shared coverage invariant: no duplicate variant assignments, every assignment
 * points at an existing derivative profile, and every derivative profile is
 * assigned (exact/bijective coverage). Throws on the first violation.
 */
function assertAssignmentCoverage(
  profiles: Set<string>,
  assignments: readonly { variantKey: string; profileKey: string }[],
): void {
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (seen.has(assignment.variantKey)) {
      throw new Error(`Manifest contains a duplicate assignment for variant ${assignment.variantKey}`);
    }
    seen.add(assignment.variantKey);
    if (!profiles.has(assignment.profileKey)) {
      throw new Error(`Assignment for variant ${assignment.variantKey} references missing profile ${assignment.profileKey}`);
    }
  }
  for (const profile of profiles) {
    if (!assignments.some((assignment) => assignment.profileKey === profile)) {
      throw new Error(`Derivative profile ${profile} has no variant assignment (incomplete coverage)`);
    }
  }
}

/**
 * Structurally parse a schema-v2 manifest, then enforce mode-neutral invariants:
 * unique derived profiles, signature-box consistency, renderer-2.1 placement
 * recomputation with canvas-bounds, and exact assignment coverage. Does not read
 * files or config; `loadManifestV2` adds the current-renderer requirement and
 * preflight adds config equality + source-byte checks.
 */
export function parsePrepareManifest(value: unknown): PrepareManifest {
  if (isRecord(value) && value.schemaVersion !== 2) {
    throw new Error(`Manifest schemaVersion must be 2, got ${JSON.stringify(value.schemaVersion)}`);
  }
  const parsed = prepareManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid manifest schema v2: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;

  const hasSignature = manifest.signature != null;
  const profiles = new Set<string>();
  for (const derivative of manifest.derivatives) {
    const profileKey = profileKeyFromPx(derivative.width, derivative.height);
    if (profiles.has(profileKey)) throw new Error(`Manifest contains a duplicate derivative profile ${profileKey}`);
    profiles.add(profileKey);

    if ((derivative.signatureBoxPx != null) !== hasSignature) {
      throw new Error(`Derivative ${profileKey} signatureBoxPx presence does not match the manifest signature layer`);
    }

    const placement = resolvePlacement(
      manifest.layout,
      { w: derivative.width, h: derivative.height },
      { w: manifest.artwork.width, h: manifest.artwork.height },
      hasSignature,
    );
    const boundErrors = validatePlacement(placement, { w: derivative.width, h: derivative.height });
    if (boundErrors.length > 0) {
      throw new Error(`Derivative ${profileKey} placement is out of bounds: ${boundErrors.join('; ')}`);
    }

    const recomputedArtwork: Box = {
      x: placement.artworkPos.x,
      y: placement.artworkPos.y,
      width: placement.artworkOut.width,
      height: placement.artworkOut.height,
    };
    if (!boxesEqual(recomputedArtwork, derivative.artworkBoxPx)) {
      throw new Error(
        `Derivative ${profileKey} artworkBoxPx ${JSON.stringify(derivative.artworkBoxPx)} does not match the ` +
          `renderer-${COMPOSE_RENDERER_VERSION} placement ${JSON.stringify(recomputedArtwork)} (layout/source drift)`,
      );
    }
    if (!boxesEqual(placement.signatureBox, derivative.signatureBoxPx)) {
      throw new Error(
        `Derivative ${profileKey} signatureBoxPx ${JSON.stringify(derivative.signatureBoxPx)} does not match the ` +
          `recomputed signature zone ${JSON.stringify(placement.signatureBox)} (layout/source drift)`,
      );
    }
  }

  assertAssignmentCoverage(profiles, manifest.assignments);
  return manifest;
}

// ── Validated legacy publish projection ──────────────────────────────────────

/**
 * The normalized publish input both manifest formats project into. Only the
 * immutable key-bearing facts survive; publish re-derives profile/MIME/R2 key
 * and the RPC revalidates live coverage, ownership, dimensions, and readiness.
 */
export interface PublishManifest {
  product: string;
  revision: string;
  derivatives: Array<{
    width: number;
    height: number;
    format: DerivativeFormat;
    sha256: string;
  }>;
  assignments: Array<{ variantKey: string; profileKey: string }>;
}

// Permissive-on-extra, strict-on-required legacy derivative. Both known legacy
// shapes (2026-07-12-r1 flat, 2026-07-19-r2 with layout snapshot) carry these
// stored derived facts; extra fields (artworkBoxPx, …) are ignored.
const legacyDerivativeSchema = z.object({
  profileKey: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: formatSchema,
  contentType: z.string(),
  sha256: sha256Schema,
  byteSize: z.number().int().positive(),
  r2Key: z.string(),
});
const legacyManifestSchema = z.object({
  product: safeSegmentSchema,
  revision: safeSegmentSchema,
  derivatives: z.array(legacyDerivativeSchema).min(1),
  assignments: z.array(assignmentSchema).min(1),
});

/** True when `value` is a structurally recognized pre-v2 (legacy) manifest. */
export function isRecognizedLegacyManifest(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === undefined && legacyManifestSchema.safeParse(value).success;
}

/**
 * Parse a manifest for publish: schema-v2 directly, or a validated legacy
 * projection (recompute + compare stored profileKey/contentType/r2Key, reject
 * duplicates and inconsistent coverage). Intentionally does NOT require the
 * current renderer or tracked config — rollback must survive rendering/config
 * changes; only the immutable key-bearing facts and exact coverage are checked.
 */
export function parsePublishManifest(value: unknown): PublishManifest {
  if (isRecord(value) && value.schemaVersion !== undefined) {
    if (value.schemaVersion === 2) {
      const v2 = parsePrepareManifest(value);
      return projectPublishManifest(v2.product, v2.revision, v2.derivatives, v2.assignments);
    }
    throw new Error(
      `Unsupported manifest schemaVersion ${JSON.stringify(value.schemaVersion)} (expected 2 or a recognized legacy manifest)`,
    );
  }

  const parsed = legacyManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid legacy manifest: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;

  const profiles = new Set<string>();
  for (const derivative of manifest.derivatives) {
    const expectedProfile = profileKeyFromPx(derivative.width, derivative.height);
    if (derivative.profileKey !== expectedProfile) {
      throw new Error(
        `Legacy derivative profileKey "${derivative.profileKey}" does not match its ${expectedProfile} dimensions`,
      );
    }
    if (profiles.has(expectedProfile)) {
      throw new Error(`Legacy manifest contains a duplicate derivative profile ${expectedProfile}`);
    }
    profiles.add(expectedProfile);

    const expectedContentType = contentTypeForFormat(derivative.format);
    if (derivative.contentType !== expectedContentType) {
      throw new Error(
        `Legacy derivative contentType "${derivative.contentType}" does not match format ${derivative.format} ` +
          `(expected ${expectedContentType})`,
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
      throw new Error(
        `Legacy derivative r2Key "${derivative.r2Key}" is inconsistent with its content-addressed key ${expectedR2Key}`,
      );
    }
  }

  assertAssignmentCoverage(profiles, manifest.assignments);
  return projectPublishManifest(manifest.product, manifest.revision, manifest.derivatives, manifest.assignments);
}

function projectPublishManifest(
  product: string,
  revision: string,
  derivatives: readonly { width: number; height: number; format: DerivativeFormat; sha256: string }[],
  assignments: readonly { variantKey: string; profileKey: string }[],
): PublishManifest {
  return {
    product,
    revision,
    derivatives: derivatives.map((d) => ({ width: d.width, height: d.height, format: d.format, sha256: d.sha256 })),
    assignments: assignments.map((a) => ({ variantKey: a.variantKey, profileKey: a.profileKey })),
  };
}

// ── Build manifest v2 ─────────────────────────────────────────────────────────

export interface BuildManifestInput {
  product: string;
  revision: string;
  /** SHA-256 of the tracked config's raw bytes (provenance). */
  configSha256: string;
  background: string;
  layout: PrintLayout;
  /** Repository-relative normalized POSIX path — never an absolute path. */
  artworkManifestPath: string;
  artworkSha256: string;
  artworkWidth: number;
  artworkHeight: number;
  /** Repository-relative normalized POSIX path, or null when there is no signature. */
  signatureManifestPath: string | null;
  signatureSha256: string | null;
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

/**
 * Build a schema-v2 manifest, storing each fact once. Derivative entries carry
 * only dimensions, format, hash, byte size, and the resolved boxes — consumers
 * derive profileKey / contentType / r2Key from those canonical fields.
 */
export function buildManifest(input: BuildManifestInput): PrepareManifest {
  const derivatives: ManifestDerivative[] = input.profiles.map((profile) => {
    const meta = input.derivativeMeta[profile.profileKey];
    if (!meta) throw new Error(`Missing derivative output for profile ${profile.profileKey}`);
    return {
      width: profile.w,
      height: profile.h,
      format: meta.format,
      sha256: meta.sha256,
      byteSize: meta.byteSize,
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
    schemaVersion: 2,
    product: input.product,
    revision: input.revision,
    rendererVersion: COMPOSE_RENDERER_VERSION,
    configSha256: input.configSha256,
    background: input.background,
    layout: input.layout,
    artwork: {
      path: input.artworkManifestPath,
      sha256: input.artworkSha256,
      width: input.artworkWidth,
      height: input.artworkHeight,
    },
    signature:
      input.signatureManifestPath && input.signatureSha256
        ? { path: input.signatureManifestPath, sha256: input.signatureSha256 }
        : null,
    derivatives,
    assignments,
  };
}
