/**
 * Pure helpers for Phase 2b of the print-asset pipeline
 * (docs/plans/print-asset-pipeline.md → Phase 2 `upload` / `verify` / `publish`
 * bullets). Consumes the `manifest.json` Phase 2a wrote
 * (src/lib/print-assets-prepare.ts) and produces the deterministic row/decision
 * shapes the three operator scripts turn into R2 and Supabase I/O.
 *
 * No I/O, no Sharp, no wrangler, no Supabase — importable by the scripts and by
 * unit tests without a live bucket or database. The scripts own the side
 * effects; this module owns the fail-closed decisions.
 */
import {
  contentTypeForFormat,
  derivativeR2Key,
  profileKeyFromPx,
  type ManifestDerivative,
  type PrepareManifest,
  type PublishManifest,
} from './print-assets-prepare';

// ── Staging rows — print_fulfilment_assets ───────────────────────────────────

/** Content-type union `print_fulfilment_assets.content_type` accepts (check constraint). */
export type AssetContentType = 'image/jpeg' | 'image/png';

/**
 * An insertable `print_fulfilment_assets` row (snake_case = the exact column
 * names the migration defines). `upload` stages these with `status='staged'`
 * only after every R2 put succeeds; `verify` promotes them to `ready`.
 */
export interface StagedAssetRow {
  product_id: string;
  revision: string;
  profile_key: string;
  r2_key: string;
  sha256: string;
  content_type: AssetContentType;
  width_px: number;
  height_px: number;
  byte_size: number;
  status: 'staged';
}

/**
 * One staged `print_fulfilment_assets` row per manifest derivative. The v2
 * derivative stores each fact once — the content-addressed `r2_key`, the
 * `profile_key`, and the `content_type` the migration's columns require are all
 * derived here from the canonical dimensions/format/hash, so `verify`/`publish`
 * compare against exactly what `prepare` produced.
 */
export function buildStagedRows(manifest: PrepareManifest): StagedAssetRow[] {
  return manifest.derivatives.map((d) => ({
    product_id: manifest.product,
    revision: manifest.revision,
    profile_key: profileKeyFromPx(d.width, d.height),
    r2_key: derivativeR2Key(manifest, d),
    sha256: d.sha256,
    content_type: contentTypeForFormat(d.format),
    width_px: d.width,
    height_px: d.height,
    byte_size: d.byteSize,
    status: 'staged',
  }));
}

// ── Upload decision — reuse vs put vs abort ───────────────────────────────────

/** What `upload` should do with one derivative given the current remote state. */
export type UploadAction = 'put' | 'skip';

export interface RemoteProbe {
  /** Full SHA-256 of the object already at the derivative's key, if present. */
  sha256: string;
}

/**
 * Decide whether a derivative must be uploaded (`put`) or already exists
 * byte-identically (`skip`). The R2 key is content-addressed
 * (`…/{w}x{h}-{sha256}.{ext}`), so a present object whose streamed hash differs
 * from the derivative's is a corrupted/foreign object under an immutable key:
 * abort loudly rather than overwrite (plan §2 "Never overwrite a key").
 */
export function decideUploadAction(
  derivative: { sha256: string; r2Key: string },
  remote: RemoteProbe | null,
): UploadAction {
  if (remote === null) return 'put';
  if (remote.sha256 !== derivative.sha256) {
    throw new Error(
      `Refusing to overwrite ${derivative.r2Key}: an object already exists at this content-addressed key but its ` +
        `SHA-256 (${remote.sha256.slice(0, 12)}…) does not match the local derivative (${derivative.sha256.slice(0, 12)}…). ` +
        'This key must never carry different bytes — investigate before re-running.',
    );
  }
  return 'skip';
}

/** How a single fulfilment derivative was reconciled against R2. */
export type FulfilmentUploadOutcome =
  /** A byte-identical object already occupied the key — reused, no write. */
  | 'present'
  /** Created here via the conditional PUT and verified by read-back. */
  | 'created'
  /** A concurrent writer created it first (412) — verified by read-back. */
  | 'reused'
  /** Dry-run: absent, would have created, but no write was performed. */
  | 'dry-run';

/**
 * The injected R2 side-effects `uploadFulfilmentDerivative` orchestrates. Each
 * probe/read-back returns the object's streamed hash or `null` when definitively
 * absent, and MUST throw on any unresolved fault (auth/network) so a transient
 * error can never be mistaken for "absent". `create` is the conditional
 * `If-None-Match: *` PUT (`r2PutIfAbsent`).
 */
export interface FulfilmentUploadEffects {
  probe: () => Promise<RemoteProbe | null>;
  create: () => Promise<'created' | 'exists'>;
  readBack: () => Promise<RemoteProbe | null>;
}

/**
 * Reconcile one fulfilment derivative into its immutable content-addressed R2
 * key, create-only and race-safe (plan §2 "Never overwrite a key"):
 *   1. Probe the key. A byte-identical object → reuse (`present`); a different
 *      object → abort (`decideUploadAction` throws).
 *   2. Absent + dry-run → `dry-run`, performing NO write.
 *   3. Absent → conditional create. Whether it reports `created` or loses the
 *      race (`exists`/412), download + hash the resulting object and abort
 *      unless it matches this derivative's bytes exactly. Only a verified object
 *      lets the caller stage its DB row.
 * Every abort throws before any row is staged.
 */
export async function uploadFulfilmentDerivative(
  derivative: { sha256: string; r2Key: string },
  effects: FulfilmentUploadEffects,
  options: { dryRun: boolean },
): Promise<FulfilmentUploadOutcome> {
  const existing = await effects.probe();
  if (decideUploadAction(derivative, existing) === 'skip') return 'present';

  // Absent under an immutable key. A dry-run reads but never writes.
  if (options.dryRun) return 'dry-run';

  const created = await effects.create();
  const readBack = await effects.readBack();
  if (readBack === null) {
    throw new Error(
      `Read-back failed for ${derivative.r2Key}: the object is absent immediately after a "${created}" ` +
        'response. Refusing to stage — resolve the R2 access issue and re-run.',
    );
  }
  if (readBack.sha256 !== derivative.sha256) {
    throw new Error(
      `Read-back mismatch for ${derivative.r2Key}: the stored object hashes ${readBack.sha256.slice(0, 12)}… but the ` +
        `local derivative is ${derivative.sha256.slice(0, 12)}…. A concurrent writer stored different bytes under ` +
        'this content-addressed key — refusing to stage.',
    );
  }
  return created === 'created' ? 'created' : 'reused';
}

// ── Staging reconciliation — idempotent re-runs ───────────────────────────────

export interface StagedRowPartition {
  /** Rows whose r2_key has no existing DB row — safe to insert. */
  toInsert: StagedAssetRow[];
  /** r2_keys already present with a MATCHING sha256 — nothing to do. */
  alreadyStaged: string[];
  /** r2_keys present with a DIFFERENT sha256 — an immutable-key violation. */
  conflicts: string[];
}

/**
 * Split desired staged rows against the rows already in `print_fulfilment_assets`
 * for this (product, revision). Re-running `upload` after a partial failure must
 * be idempotent: keys already staged with matching bytes are skipped, brand-new
 * keys are inserted, and a same-key/different-hash row is a conflict the caller
 * must refuse (the content-addressed key guarantees this can only happen if a
 * row was hand-edited or a hash collided — either way, do not silently proceed).
 */
export function partitionStagedRows(
  desired: StagedAssetRow[],
  existingByKey: Map<string, { sha256: string }>,
): StagedRowPartition {
  const toInsert: StagedAssetRow[] = [];
  const alreadyStaged: string[] = [];
  const conflicts: string[] = [];

  for (const row of desired) {
    const existing = existingByKey.get(row.r2_key);
    if (!existing) {
      toInsert.push(row);
    } else if (existing.sha256 === row.sha256) {
      alreadyStaged.push(row.r2_key);
    } else {
      conflicts.push(row.r2_key);
    }
  }

  return { toInsert, alreadyStaged, conflicts };
}

// ── Verify — remote object vs manifest ────────────────────────────────────────

/** Facts read back from R2 for one object (streamed hash + decoded image header). */
export interface RemoteObjectFacts {
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}

/**
 * Compare a re-downloaded R2 object against the manifest derivative that
 * produced it. A full SHA-256 match already proves byte-identity; size and
 * decoded dimensions are checked too so a mismatch is reported specifically
 * rather than as an opaque hash difference. Returns error strings (empty =
 * verified) so `verify` can report every problem for a profile at once.
 */
export function compareRemoteToManifest(
  derivative: ManifestDerivative,
  remote: RemoteObjectFacts,
): string[] {
  const errors: string[] = [];
  if (remote.sha256 !== derivative.sha256) {
    errors.push(
      `sha256 mismatch: remote ${remote.sha256.slice(0, 12)}… vs manifest ${derivative.sha256.slice(0, 12)}…`,
    );
  }
  if (remote.byteSize !== derivative.byteSize) {
    errors.push(`byte size mismatch: remote ${remote.byteSize} vs manifest ${derivative.byteSize}`);
  }
  if (remote.width !== derivative.width || remote.height !== derivative.height) {
    errors.push(
      `dimension mismatch: remote ${remote.width}x${remote.height} vs manifest ${derivative.width}x${derivative.height}`,
    );
  }
  return errors;
}

// ── Publish preflight — catalogue drift since prepare ─────────────────────────

export interface VariantCoverageDiff {
  /** active variant_keys the manifest does not cover (added since prepare). */
  missing: string[];
  /** manifest variant_keys no longer active (removed/deactivated since prepare). */
  extra: string[];
}

/**
 * Compare the manifest's assignment variant_keys (frozen at prepare time)
 * against the product's currently-active variant_keys. Any drift means the
 * catalogue changed since prepare — the atomic RPC would reject it with an
 * opaque `assignment_mismatch`, so publish surfaces this precise diff first and
 * tells the operator to re-run prepare. Sorted for stable output.
 */
export function diffVariantCoverage(
  activeKeys: string[],
  manifestKeys: string[],
): VariantCoverageDiff {
  const active = new Set(activeKeys);
  const manifest = new Set(manifestKeys);
  return {
    missing: activeKeys.filter((k) => !manifest.has(k)).sort(),
    extra: manifestKeys.filter((k) => !active.has(k)).sort(),
  };
}

// ── Publish — assignments for publish_print_asset_revision ────────────────────

/** One `(variant_key, asset_id)` pair in the `p_assignments` jsonb the RPC takes. */
export interface PublishAssignment {
  variant_key: string;
  asset_id: string;
}

/**
 * Turn the manifest's variant→profile assignments into the variant→asset_id
 * assignments the `publish_print_asset_revision` RPC consumes. Each variant maps
 * to its profile's derivative, and each derivative's R2 key resolves to the uuid
 * of the `ready` DB row the caller looked up. Fails closed when a profile has no
 * derivative or a derivative has no ready DB row — the RPC would reject those
 * anyway, but surfacing the missing key here gives a precise operator error.
 */
export function buildPublishAssignments(
  manifest: PublishManifest,
  assetIdByR2Key: Map<string, string>,
): PublishAssignment[] {
  const r2KeyByProfile = new Map(
    manifest.derivatives.map((d) => [profileKeyFromPx(d.width, d.height), derivativeR2Key(manifest, d)]),
  );

  return manifest.assignments.map((assignment) => {
    const r2Key = r2KeyByProfile.get(assignment.profileKey);
    if (!r2Key) {
      throw new Error(
        `Variant "${assignment.variantKey}" maps to profile "${assignment.profileKey}", but the manifest has no ` +
          'derivative for that profile.',
      );
    }
    const assetId = assetIdByR2Key.get(r2Key);
    if (!assetId) {
      throw new Error(
        `No ready print_fulfilment_assets row for ${r2Key} (variant "${assignment.variantKey}", profile ` +
          `"${assignment.profileKey}"). Run print-assets:verify to promote staged assets to ready before publishing.`,
      );
    }
    return { variant_key: assignment.variantKey, asset_id: assetId };
  });
}
