/**
 * Shared CLI plumbing for the print-asset operator scripts: arg parsing,
 * loading the tracked config, and loading the `manifest.json` that `prepare`
 * wrote. Every runtime-JSON read (config, manifest) is validated before any
 * nested field, derived path, or R2/Supabase access.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  COMPOSE_RENDERER_VERSION,
  isRecognizedLegacyManifest,
  parsePrepareManifest,
  parsePublishManifest,
  validatePrepareConfig,
  PRINT_RATIOS,
  type FullBleedPrepareConfig,
  type PosterPrepareConfig,
  type PrepareConfig,
  type PrepareManifest,
  type PrintRatio,
  type PublishManifest,
} from '../../src/lib/print-assets-prepare';

export const ROOT = path.resolve(__dirname, '..', '..');

export interface ScriptArgSpec<S extends string = string, B extends string = string> {
  strings?: readonly S[];
  booleans?: readonly B[];
}

export type ParsedScriptArgs<S extends string, B extends string> =
  Record<S, string | undefined> &
  Record<B, boolean | undefined> &
  { 'env-file': string | undefined };

export const PRINT_ASSET_ARG_SPECS = {
  prepare: { strings: ['product', 'revision'], booleans: ['force', 'dry-run'] },
  upload: { strings: ['product', 'revision'], booleans: ['dry-run'] },
  verify: { strings: ['product', 'revision'], booleans: ['dry-run'] },
  publish: { strings: ['product', 'revision', 'confirm', 'actor'], booleans: ['dry-run'] },
  gallery: { strings: ['product', 'slot', 'revision'], booleans: ['dry-run'] },
  mockups: { strings: ['product', 'state', 'revision'], booleans: ['dry-run'] },
  editorial: { strings: ['product'], booleans: ['all', 'dry-run'] },
  onboard: { strings: ['manifest'], booleans: ['dry-run', 'force'] },
} as const;

/**
 * `--env-file <path>` / `--env-file=<path>`, tolerant of any other flags in
 * `argv` (non-strict, positionals allowed) so both `parseScriptArgs` and
 * `script-env.ts`'s `loadLocalEnv` can pull the same value regardless of a
 * given script's own spec. Supplied more than once, or with an empty value,
 * is rejected rather than silently taking the last one.
 */
export function parseEnvFileOption(argv: string[] = process.argv.slice(2)): string | undefined {
  const { values } = parseArgs({
    args: argv,
    options: { 'env-file': { type: 'string', multiple: true } },
    strict: false,
    allowPositionals: true,
  });
  // `strict: false` widens @types/node's inferred value type to `string | boolean`
  // for every option — and that widening is real at runtime: even a declared
  // `type: 'string'` option parses as boolean `true` when its value is missing
  // (bare `--env-file` as the last token), so normalise before validating.
  const raw = values['env-file'] as string | boolean | Array<string | boolean> | undefined;
  const valuesList = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  if (valuesList.length > 1) throw new Error('--env-file may be supplied only once');
  const value = valuesList[0];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('--env-file requires a value');
  if (value.trim() === '') throw new Error('--env-file must be non-empty');
  return value;
}

/**
 * Strict typed CLI parsing shared by every print-asset operator script — one
 * parser instead of each script scanning `process.argv` by hand. Backed by
 * `node:util`'s `parseArgs` in `strict` mode: an unknown flag, a bare
 * positional, a missing string value, or a `--no-x`/`--x=value` negation of a
 * boolean all throw instead of being silently accepted or misparsed.
 * `--env-file` is always recognised (see `parseEnvFileOption`) and reserved —
 * no spec may redeclare it.
 */
export function parseScriptArgs<const S extends string, const B extends string>(
  spec: ScriptArgSpec<S, B>,
  argv: string[] = process.argv.slice(2),
): ParsedScriptArgs<S, B> {
  const strings = spec.strings ?? [];
  const booleans = spec.booleans ?? [];
  const stringSet = new Set<string>(strings);
  for (const name of booleans) {
    if (stringSet.has(name)) throw new Error(`Option --${name} cannot be both string and boolean`);
  }
  if (stringSet.has('env-file') || booleans.includes('env-file' as B)) {
    throw new Error('--env-file is reserved as a string option');
  }
  const envFile = parseEnvFileOption(argv);
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    'env-file': { type: 'string' },
  };
  for (const name of strings) options[name] = { type: 'string' };
  for (const name of booleans) options[name] = { type: 'boolean' };
  const { values } = parseArgs({
    args: argv,
    options,
    strict: true,
    allowPositionals: false,
    allowNegative: false,
  });
  return { ...values, 'env-file': envFile } as ParsedScriptArgs<S, B>;
}

/** A single path segment safe to interpolate under `design/print-assets/`. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject a productId/revision that isn't a plain path segment — no separators,
 * no `..` — so operator-supplied args can't traverse out of the print-assets
 * tree when they build a manifest/derivative path.
 */
function assertSafeSegment(kind: string, value: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '..') {
    throw new Error(`Invalid ${kind} "${value}": expected a plain name (letters, digits, . _ -), no path separators.`);
  }
  return value;
}

/**
 * Absolute path to a revision's local output directory (gitignored `design/`
 * tree). `root` defaults to the repo root; tests pass a temp root.
 */
export function revisionDir(productId: string, revision: string, root: string = ROOT): string {
  return path.join(
    root,
    'design',
    'print-assets',
    assertSafeSegment('product', productId),
    assertSafeSegment('revision', revision),
  );
}

/** Absolute path to a derivative's local file (as `prepare` named it). */
export function localDerivativePath(
  productId: string,
  revision: string,
  profileKey: string,
  sha256: string,
  format: string,
  root: string = ROOT,
): string {
  return path.join(revisionDir(productId, revision, root), `${profileKey}-${sha256}.${format}`);
}

// ── Tracked config ────────────────────────────────────────────────────────────

/**
 * A validated tracked config plus its provenance. `sha256` is over the raw
 * config bytes (recorded in the manifest); `manifestPath` fields are the
 * normalized repository-relative POSIX paths; `absolutePath` fields are for
 * local I/O only and are never serialized.
 */
export interface LoadedPosterPrepareConfig {
  value: PosterPrepareConfig;
  configPath: string;
  sha256: string;
  artwork: { manifestPath: string; absolutePath: string };
  signature: { manifestPath: string; absolutePath: string } | null;
}

/**
 * Full-bleed configs have no single artwork/signature — one resolved source
 * per print ratio instead. Sources live under the shared canonical
 * `design/uploads/master-images-prints/` pool (docs/plans/
 * full-bleed-print-assets-plan.md), not `design/print-assets/{productId}/`,
 * so they are guarded against escaping `design/` broadly rather than the
 * narrower per-product directory poster configs use.
 */
export interface LoadedFullBleedPrepareConfig {
  value: FullBleedPrepareConfig;
  configPath: string;
  sha256: string;
  sources: Record<PrintRatio, { manifestPath: string; absolutePath: string }>;
}

export type LoadedPrepareConfig = LoadedPosterPrepareConfig | LoadedFullBleedPrepareConfig;

/** Type-guard narrowing helper — nested-discriminant (`config.value.mode`) narrowing isn't inferred automatically. */
export function isFullBleedConfig(config: LoadedPrepareConfig): config is LoadedFullBleedPrepareConfig {
  return config.value.mode === 'fullBleed';
}

/** Resolve a config path under `design/print-assets/{productId}`, rejecting any escape. */
function resolveUnderProduct(root: string, productId: string, manifestPath: string, label: string): string {
  const productDir = path.join(root, 'design', 'print-assets', productId);
  const absolute = path.resolve(root, manifestPath);
  const relative = path.relative(productDir, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Config ${label} path "${manifestPath}" resolves outside design/print-assets/${productId} — refusing.`,
    );
  }
  return absolute;
}

/** Resolve a config path under `design/`, rejecting any escape (full-bleed sources). */
function resolveUnderDesign(root: string, manifestPath: string, label: string): string {
  const designDir = path.join(root, 'design');
  const absolute = path.resolve(root, manifestPath);
  const relative = path.relative(designDir, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Config ${label} path "${manifestPath}" resolves outside design/ — refusing.`);
  }
  return absolute;
}

/**
 * Load + validate `config/print-assets/{productId}.json`, hash its raw bytes,
 * and resolve its artwork/signature (poster) or per-ratio source (fullBleed)
 * paths. Fails loudly on a missing, unparseable, structurally invalid, or
 * path-escaping config before any Sharp/Supabase/R2 work.
 */
export function loadPrepareConfig(productId: string, root: string = ROOT): LoadedPrepareConfig {
  assertSafeSegment('product', productId);
  const configPath = path.join(root, 'config', 'print-assets', `${productId}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No tracked config for product "${productId}" — expected ${path.relative(root, configPath)}.`);
  }
  const raw = fs.readFileSync(configPath);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Invalid JSON in config ${path.relative(root, configPath)}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const errors = validatePrepareConfig(parsed, productId);
  if (errors.length > 0) {
    throw new Error(`Invalid prepare config ${path.relative(root, configPath)}:\n  - ${errors.join('\n  - ')}`);
  }
  const value = parsed as PrepareConfig;

  if (value.mode === 'fullBleed') {
    const sources = {} as Record<PrintRatio, { manifestPath: string; absolutePath: string }>;
    for (const ratio of PRINT_RATIOS) {
      const manifestPath = value.sources[ratio];
      sources[ratio] = {
        manifestPath,
        absolutePath: resolveUnderDesign(root, manifestPath, `sources.${ratio}`),
      };
    }
    return { value, configPath, sha256, sources };
  }

  const artwork = {
    manifestPath: value.artwork,
    absolutePath: resolveUnderProduct(root, productId, value.artwork, 'artwork'),
  };
  const signature = value.signature
    ? {
        manifestPath: value.signature.svg,
        absolutePath: resolveUnderProduct(root, productId, value.signature.svg, 'signature.svg'),
      }
    : null;

  return { value, configPath, sha256, artwork, signature };
}

// ── Manifest loading ──────────────────────────────────────────────────────────

/**
 * Read + JSON-parse a manifest file. Returns `undefined` value when the file is
 * absent; throws on invalid JSON, always naming the manifest path.
 */
function readManifestFile(
  productId: string,
  revision: string,
  root: string,
): { rel: string; value: unknown | undefined } {
  const file = path.join(revisionDir(productId, revision, root), 'manifest.json');
  const rel = path.relative(root, file);
  if (!fs.existsSync(file)) return { rel, value: undefined };
  const rawText = fs.readFileSync(file, 'utf8');
  try {
    return { rel, value: JSON.parse(rawText) };
  } catch (error) {
    throw new Error(`Invalid JSON in manifest ${rel}: ${error instanceof Error ? error.message : error}`);
  }
}

function assertManifestIdentity(
  rel: string,
  product: string,
  revision: string,
  expectedProduct: string,
  expectedRevision: string,
): void {
  if (product !== expectedProduct || revision !== expectedRevision) {
    throw new Error(
      `Manifest at ${rel} declares ${product}@${revision}, expected ${expectedProduct}@${expectedRevision}.`,
    );
  }
}

/**
 * Load + validate the current-renderer schema-v2 manifest (the upload/verify
 * contract). Rejects a missing manifest, any structural/semantic invalidity, an
 * identity mismatch, or a manifest written by a different renderer version.
 */
export function loadManifestV2(productId: string, revision: string, root: string = ROOT): PrepareManifest {
  const { rel, value } = readManifestFile(productId, revision, root);
  if (value === undefined) {
    throw new Error(`No manifest at ${rel}. Run print-assets:prepare for ${productId} @ ${revision} first.`);
  }
  const manifest = parsePrepareManifest(value);
  assertManifestIdentity(rel, manifest.product, manifest.revision, productId, revision);
  if (manifest.rendererVersion !== COMPOSE_RENDERER_VERSION) {
    throw new Error(
      `Manifest ${rel} was written by renderer ${manifest.rendererVersion}, but this pipeline requires ` +
        `${COMPOSE_RENDERER_VERSION}. Re-run print-assets:prepare.`,
    );
  }
  return manifest;
}

/**
 * Load a manifest for publish: schema-v2 directly, or a validated legacy
 * projection (rollback path). Does not require the current renderer.
 */
export function loadPublishManifest(productId: string, revision: string, root: string = ROOT): PublishManifest {
  const { rel, value } = readManifestFile(productId, revision, root);
  if (value === undefined) {
    throw new Error(`No manifest at ${rel}. Run print-assets:prepare for ${productId} @ ${revision} first.`);
  }
  const manifest = parsePublishManifest(value);
  assertManifestIdentity(rel, manifest.product, manifest.revision, productId, revision);
  return manifest;
}

/**
 * Best-effort v2 load for gallery. Returns the parsed manifest for a valid v2
 * manifest, `null` for a missing or structurally recognized legacy manifest
 * (→ verified R2 fallback), and THROWS for invalid JSON, an unknown schema
 * version, or malformed schema-v2 data — local corruption is never hidden
 * behind the R2 branch.
 */
export function tryLoadManifestV2(productId: string, revision: string, root: string = ROOT): PrepareManifest | null {
  const { rel, value } = readManifestFile(productId, revision, root);
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error(`Malformed manifest at ${rel}: expected a JSON object`);
  const schemaVersion = value.schemaVersion;
  if (schemaVersion === 2) return parsePrepareManifest(value);
  if (schemaVersion !== undefined) {
    throw new Error(`Unsupported manifest schemaVersion ${JSON.stringify(schemaVersion)} at ${rel}`);
  }
  if (isRecognizedLegacyManifest(value)) return null;
  throw new Error(`Malformed legacy manifest at ${rel}: not a recognized print-asset manifest shape`);
}
