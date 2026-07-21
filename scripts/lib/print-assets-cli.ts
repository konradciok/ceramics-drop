/**
 * Shared CLI plumbing for the Phase 2b print-asset operator scripts
 * (upload / verify / publish): arg parsing and loading the `manifest.json`
 * that Phase 2a's `prepare` wrote.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { PrepareManifest } from '../../src/lib/print-assets-prepare';

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

/** Absolute path to a revision's local output directory (gitignored `design/` tree). */
export function revisionDir(productId: string, revision: string): string {
  return path.join(
    ROOT,
    'design',
    'print-assets',
    assertSafeSegment('product', productId),
    assertSafeSegment('revision', revision),
  );
}

/**
 * Load + validate the manifest `prepare` wrote for (product, revision). Fails
 * loudly when it is missing (prepare not run) or its embedded product/revision
 * disagree with the requested ones — the manifest is the contract every later
 * phase reads, so a mismatch must never be papered over.
 */
export function loadManifest(productId: string, revision: string): PrepareManifest {
  const manifestPath = path.join(revisionDir(productId, revision), 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No manifest at ${path.relative(ROOT, manifestPath)}. Run print-assets:prepare for ` +
        `${productId} @ ${revision} first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PrepareManifest;
  if (manifest.product !== productId || manifest.revision !== revision) {
    throw new Error(
      `Manifest at ${path.relative(ROOT, manifestPath)} declares ${manifest.product}@${manifest.revision}, ` +
        `expected ${productId}@${revision}.`,
    );
  }
  if (!Array.isArray(manifest.derivatives) || manifest.derivatives.length === 0) {
    throw new Error(`Manifest for ${productId}@${revision} has no derivatives.`);
  }
  return manifest;
}

/** Absolute path to a derivative's local file (as `prepare` named it). */
export function localDerivativePath(
  productId: string,
  revision: string,
  profileKey: string,
  sha256: string,
  format: string,
): string {
  return path.join(revisionDir(productId, revision), `${profileKey}-${sha256}.${format}`);
}
