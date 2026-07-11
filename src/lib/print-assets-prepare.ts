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

// ── Crop / enlargement guards ────────────────────────────────────────────────

/**
 * The explicit crop region of the source master (plan §1: "Require an explicit
 * crop/focal configuration for every distinct aspect ratio. Do not silently
 * accept Sharp's or Prodigi's centre crop.").
 */
export function validateCropAspect(
  crop: { width: number; height: number },
  target: { w: number; h: number },
): void {
  // Cross-multiply instead of comparing width/height floats directly — avoids
  // floating-point precision drift for aspect ratios that don't terminate
  // cleanly in binary (e.g. 3614/4795).
  if (crop.width * target.h !== crop.height * target.w) {
    const cropAspect = (crop.width / crop.height).toFixed(4);
    const targetAspect = (target.w / target.h).toFixed(4);
    throw new Error(
      `Crop region ${crop.width}x${crop.height} (aspect ${cropAspect}) does not match ` +
        `target aspect ${targetAspect} for ${target.w}x${target.h} print area`,
    );
  }
}

/** Fail preparation when the source (after crop) cannot cover the target pixels. */
export function validateNoEnlargement(
  source: { width: number; height: number },
  target: { w: number; h: number },
): void {
  if (source.width < target.w || source.height < target.h) {
    throw new Error(
      `Cannot enlarge: source region ${source.width}x${source.height} is smaller than ` +
        `target ${target.w}x${target.h}`,
    );
  }
}

// ── Tracked config — config/print-assets/{productId}.json ──────────────────

/** One explicit crop/focal per distinct print-area dimension (profileKey). */
export interface PrepareConfig {
  product: string;
  profiles: Record<
    string, // profileKey, e.g. '3600x4800'
    {
      format: DerivativeFormat;
      crop: { left: number; top: number; width: number; height: number };
    }
  >;
}

/**
 * Validate that every configured profile has active-variant coverage and vice
 * versa, BEFORE any derivative work runs. A stale config (drifted from the
 * catalogue) must fail loudly here rather than silently under- or
 * over-producing derivatives. Returns error strings (empty = valid).
 */
export function validateProfileCoverage(
  configProfileKeys: string[],
  activeProfiles: DerivativeProfile[],
): string[] {
  const errors: string[] = [];
  const configSet = new Set(configProfileKeys);
  const activeSet = new Set(activeProfiles.map((p) => p.profileKey));

  for (const profileKey of activeSet) {
    if (!configSet.has(profileKey)) {
      errors.push(`Active variants require profile ${profileKey}, but config/print-assets/*.json has no entry for it`);
    }
  }
  for (const profileKey of configSet) {
    if (!activeSet.has(profileKey)) {
      errors.push(`Config declares profile ${profileKey}, but no active variant requires it (stale config entry)`);
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
  /** MIME type Phase 2b must set as R2 HTTP metadata and stage into
   *  `print_fulfilment_assets.content_type` — `wrangler r2 object put`
   *  does not infer content-type from the key, so this is the contract. */
  contentType: string;
  sha256: string;
  byteSize: number;
  r2Key: string;
}

export interface ManifestAssignment {
  variantKey: string;
  profileKey: string;
}

export interface PrepareManifest {
  product: string;
  revision: string;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  derivatives: ManifestDerivative[];
  assignments: ManifestAssignment[];
}

export interface BuildManifestInput {
  product: string;
  revision: string;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  profiles: DerivativeProfile[];
  /** Per-profile output produced by the Sharp pipeline (script-side I/O already done). */
  derivativeMeta: Record<string, { sha256: string; byteSize: number; format: DerivativeFormat }>;
}

/**
 * Assemble the manifest Phase 2b (upload/verify/publish) consumes. One
 * derivative per distinct profile; assignments map every active variant_key
 * to its profile (variants sharing a dimension share a profile — plan §1).
 */
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
    derivatives,
    assignments,
  };
}

/**
 * Validate a manifest against its tracked config: every configured profile
 * must have exactly one derivative, and that derivative's decoded dimensions
 * must equal the profile's declared dimensions. Returns a list of error
 * strings (empty = valid) rather than throwing, so callers can report every
 * problem at once.
 */
export function validateManifest(manifest: PrepareManifest, config: PrepareConfig): string[] {
  const errors: string[] = [];
  const byProfileKey = new Map(manifest.derivatives.map((d) => [d.profileKey, d]));

  for (const profileKey of Object.keys(config.profiles)) {
    const derivative = byProfileKey.get(profileKey);
    if (!derivative) {
      errors.push(`Manifest is missing a derivative for configured profile ${profileKey}`);
      continue;
    }
    const [expectedW, expectedH] = profileKey.split('x').map(Number);
    if (derivative.width !== expectedW || derivative.height !== expectedH) {
      errors.push(
        `Derivative for profile ${profileKey} has dimensions ${derivative.width}x${derivative.height}, ` +
          `expected ${expectedW}x${expectedH}`,
      );
    }
    const configured = config.profiles[profileKey];
    if (configured.format !== derivative.format) {
      errors.push(
        `Derivative for profile ${profileKey} has format ${derivative.format}, expected ${configured.format}`,
      );
    }
    const expectedContentType = CONTENT_TYPE_BY_FORMAT[derivative.format];
    if (derivative.contentType !== expectedContentType) {
      errors.push(
        `Derivative for profile ${profileKey} has contentType "${derivative.contentType}", expected "${expectedContentType}" for format ${derivative.format}`,
      );
    }
  }

  for (const derivative of manifest.derivatives) {
    if (!config.profiles[derivative.profileKey]) {
      errors.push(`Manifest has a derivative for profile ${derivative.profileKey} with no config entry`);
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
