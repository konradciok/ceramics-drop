/**
 * Shared fulfilment-asset resolution for print-asset operator scripts.
 */
import { PRODIGI_SKU_MAP, assetPxFor, parseVariantKey } from '../../src/lib/print-cart';
import { buildProdigiAttributes } from '../../src/lib/print-prodigi-attributes';
import { profileKeyFromPx } from '../../src/lib/print-assets-prepare';
import { loadSupabaseClient } from './script-env';

// Re-export the canonical profile-key helper so callers already importing it
// from this module keep working (one source of truth in print-assets-prepare).
export { profileKeyFromPx };

export interface ReadyAssetRow {
  id: string;
  profile_key: string;
  revision: string;
  sha256: string;
  verified_at: string | null;
}

export interface ReadyAssetDetail extends ReadyAssetRow {
  r2_key: string;
}

export interface SandboxMatrixRow {
  profileKey: string;
  variantKey: string;
  sku: string;
  attributes: Record<string, string>;
}

// ── Supabase row validation ───────────────────────────────────────────────────
// Every column comes back from PostgREST as untyped JSON. A DB string must
// never become a local filesystem path or an R2 key unchecked, so every row
// selected from `print_fulfilment_assets` is parsed here — at the boundary —
// before a caller can derive a path from it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mirrors print-assets-cli.ts's `SAFE_SEGMENT`: no path separators, no `..`. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Mirrors print-assets-prepare.ts's `assignmentSchema.profileKey`: positive WxH. */
const PROFILE_KEY_RE = /^[1-9]\d*x[1-9]\d*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`print_fulfilment_assets row field "${field}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireSafeSegment(row: Record<string, unknown>, field: string): string {
  const value = requireString(row, field);
  if (!SAFE_SEGMENT_RE.test(value) || value === '..') {
    throw new Error(`print_fulfilment_assets row field "${field}" is not a safe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parse + validate a raw `print_fulfilment_assets` row into a `ReadyAssetRow`.
 * Requires a UUID `id`, a safe-segment `revision` (no separators, no `..`), a
 * positive `WxH` `profile_key` (rejects a traversal-shaped value like
 * `../../etc`), a lowercase 64-hex `sha256`, and a nullable ISO `verified_at`.
 * Never casts the query row directly — every field is checked before it can
 * be used to derive a local path or an R2 key.
 */
export function parseReadyAssetRow(value: unknown): ReadyAssetRow {
  if (!isRecord(value)) throw new Error(`print_fulfilment_assets row must be an object, got ${JSON.stringify(value)}`);

  const id = requireString(value, 'id');
  if (!UUID_RE.test(id)) throw new Error(`print_fulfilment_assets row field "id" is not a UUID: ${JSON.stringify(id)}`);

  const revision = requireSafeSegment(value, 'revision');

  const profile_key = requireString(value, 'profile_key');
  if (!PROFILE_KEY_RE.test(profile_key)) {
    throw new Error(`print_fulfilment_assets row field "profile_key" is not a positive WxH profile: ${JSON.stringify(profile_key)}`);
  }

  const sha256 = requireString(value, 'sha256');
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`print_fulfilment_assets row field "sha256" is not lowercase 64-hex: ${JSON.stringify(sha256)}`);
  }

  const verifiedRaw = value.verified_at;
  if (verifiedRaw !== null && (typeof verifiedRaw !== 'string' || Number.isNaN(Date.parse(verifiedRaw)))) {
    throw new Error(`print_fulfilment_assets row field "verified_at" must be an ISO string or null, got ${JSON.stringify(verifiedRaw)}`);
  }

  return { id, revision, profile_key, sha256, verified_at: verifiedRaw };
}

/**
 * Parse a raw row into a `ReadyAssetDetail`, additionally requiring `r2_key`
 * to exactly equal the content-addressed key built from the row's OWN parsed
 * fields and the `productId` the query filtered on —
 * `prints/{product}/{revision}/{profile}-{sha256}.{jpg|png}` — compared as an
 * exact string, never matched with a loose/generic regex.
 */
export function parseReadyAssetDetail(productId: string, value: unknown): ReadyAssetDetail {
  const row = parseReadyAssetRow(value);
  const r2_key = requireString(value as Record<string, unknown>, 'r2_key');
  const expectedPrefix = `prints/${productId}/${row.revision}/${row.profile_key}-${row.sha256}.`;
  if (r2_key !== `${expectedPrefix}jpg` && r2_key !== `${expectedPrefix}png`) {
    throw new Error(
      `print_fulfilment_assets row field "r2_key" does not match its own product/revision/profile/sha256: ` +
        `expected ${expectedPrefix}{jpg|png}, got ${JSON.stringify(r2_key)}`,
    );
  }
  return { ...row, r2_key };
}

export function galleryR2Key(productId: string, slot: string, filename: string): string {
  return `prints/${productId}/gallery/${slot}/${filename}`;
}

/**
 * Given rows sorted by `verified_at` descending, keep the first (latest verified)
 * row per `profile_key`.
 */
export function latestReadyByProfile(rows: ReadyAssetRow[]): Map<string, ReadyAssetRow> {
  const byProfile = new Map<string, ReadyAssetRow>();
  for (const row of rows) {
    if (!byProfile.has(row.profile_key)) byProfile.set(row.profile_key, row);
  }
  return byProfile;
}

/**
 * One sandbox order per distinct print-area profile, derived from PRODIGI_SKU_MAP.
 * Groups by `assetPxFor()` (the asset we actually render/upload/publish), not the
 * raw `printAreaPx` (Prodigi's API drift-detection truth) — otherwise a variant
 * like `30x40:true:false:black`, which intentionally reuses the shared unframed
 * asset (prodigi/decisions.md #6), would be grouped under a profile no fulfilment
 * asset is ever published for.
 */
export function buildSandboxMatrix(): SandboxMatrixRow[] {
  const entries = Object.entries(PRODIGI_SKU_MAP).sort(([a], [b]) => a.localeCompare(b));
  const byProfile = new Map<string, { variantKey: string; sku: string }>();

  for (const [variantKey, entry] of entries) {
    const px = assetPxFor(entry);
    const profileKey = profileKeyFromPx(px.w, px.h);
    if (byProfile.has(profileKey)) continue;
    byProfile.set(profileKey, { variantKey, sku: entry.sku });
  }

  return [...byProfile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profileKey, { variantKey, sku }]) => ({
      profileKey,
      variantKey,
      sku,
      attributes: buildProdigiAttributes(parseVariantKey(variantKey)),
    }));
}

export async function resolveLatestReadyByProfile(productId: string): Promise<Map<string, ReadyAssetRow>> {
  const supabase = loadSupabaseClient();
  const { data, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, profile_key, revision, verified_at, sha256')
    .eq('product_id', productId)
    .eq('status', 'ready')
    .order('verified_at', { ascending: false, nullsFirst: false })
    .order('sha256', { ascending: false });
  if (error) throw new Error(`asset lookup failed: ${error.message}`);
  const rows = (data ?? []).map((row) => parseReadyAssetRow(row));
  return latestReadyByProfile(rows);
}

/** Latest ready asset for one profile (optional revision pin). */
export async function resolveLatestReadyAsset(
  productId: string,
  sourceProfile: string,
  revisionArg: string | undefined,
): Promise<ReadyAssetDetail> {
  const supabase = loadSupabaseClient();
  let query = supabase
    .from('print_fulfilment_assets')
    .select('id, revision, profile_key, r2_key, sha256, verified_at')
    .eq('product_id', productId)
    .eq('profile_key', sourceProfile)
    .eq('status', 'ready');

  if (revisionArg) query = query.eq('revision', revisionArg);

  const { data, error } = await query
    .order('verified_at', { ascending: false, nullsFirst: false })
    .order('sha256', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Failed to read fulfilment assets: ${error.message}`);
  if (!data?.length) {
    throw new Error(
      `No ready print_fulfilment_assets row for ${productId} profile ${sourceProfile}` +
        (revisionArg ? ` revision ${revisionArg}` : '') +
        '. Run prepare/upload/verify/publish first.',
    );
  }
  return parseReadyAssetDetail(productId, data[0]);
}
