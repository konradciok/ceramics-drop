/**
 * Prepare deterministic Prodigi print-area derivatives from one approved
 * local artwork master (Phase 2a of the print asset pipeline —
 * docs/plans/print-asset-pipeline.md → Phase 2, `prepare` bullets, Settled
 * Architecture §1).
 *
 * Enumerates a print product's active DB variants (`product_variants.active`
 * — the same source of truth `publish_print_asset_revision` and
 * `getPrintAssetReadiness` check, not the code registry), deduplicates them
 * into distinct print-area dimension profiles, validates the tracked crop
 * config for each profile against the source master, generates exact-size
 * derivatives via Sharp, and writes a manifest that Phase 2b (upload/verify/
 * publish — not yet built) consumes.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars /
 * env) and that `npm run catalog:backfill` has seeded `products` /
 * `product_variants` for the product.
 *
 * Usage:
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-11-r1 --source <path>
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-11-r1 --source <path> --force
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-11-r1 --source <path> --dry-run
 *
 * Output (gitignored): design/print-assets/{productId}/{revision}/
 *   - {w}x{h}-{sha256}.{jpg|png} per distinct profile
 *   - manifest.json (the Phase 2b contract — see src/lib/print-assets-prepare.ts)
 *   - proof-{w}x{h}.jpg — small (600px-wide) contact-sheet-style review proof
 *     per profile; visual review only, NEVER uploaded to R2 (2b reads
 *     manifest.json's `derivatives`, which never lists proof files).
 *
 * Read-only on R2 (upload is 2b's job). No DB writes (publish is a separate
 * script + the atomic RPC).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildManifest,
  distinctProfiles,
  refuseOverwrite,
  validateCropAspect,
  validateManifest,
  validateNoEnlargement,
  validateProfileCoverage,
  type DerivativeFormat,
  type PrepareConfig,
} from '../src/lib/print-assets-prepare';
import { generateDerivative, prepareOutputDir, writeDerivative } from './lib/prepare-derivatives';
import { activeVariantDimensions } from './lib/db-variants';

const ROOT = path.resolve(__dirname, '..');

/** `.env.local` / `.dev.vars` → `process.env`, mirroring backfill-catalog.ts / sync-prodigi-skus.ts. */
function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadSupabaseClient(): SupabaseClient {
  const env = { ...parseEnvFile('.env.local'), ...parseEnvFile('.dev.vars'), ...process.env };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

/** Minimal --flag value parser (supports `--flag value` and `--flag=value`), mirroring create-drop.ts. */
function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

/** Load config/print-assets/{productId}.json. Fails loudly if missing/malformed. */
function loadConfig(productId: string): PrepareConfig {
  const configPath = path.join(ROOT, 'config', 'print-assets', `${productId}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No tracked config for product "${productId}" — expected ${path.relative(ROOT, configPath)}. ` +
        'Author it first: one explicit crop/focal per distinct print-area profile (see docs/plans/print-asset-pipeline.md Phase 2).',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PrepareConfig;
  if (parsed.product !== productId) {
    throw new Error(`Config ${configPath} declares product "${parsed.product}", expected "${productId}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const productId = getArg('product');
  const revision = getArg('revision');
  const sourcePath = getArg('source');
  const force = hasFlag('force');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-11-r1)');
  if (!sourcePath) throw new Error('Missing --source (path to the approved master image)');

  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Source master not found: ${resolvedSource}`);
  }

  console.log(`print-assets:prepare — product=${productId} revision=${revision}`);
  console.log(`  source: ${resolvedSource}`);

  // 1. Enumerate active variants (DB `product_variants.active` — the SAME
  //    source of truth publish_print_asset_revision/getPrintAssetReadiness
  //    check, not the code registry) → distinct dimension profiles.
  const supabase = loadSupabaseClient();
  const variantDims = await activeVariantDimensions(supabase, productId);
  const profiles = distinctProfiles(variantDims);
  console.log(`  ${variantDims.length} active variant(s) → ${profiles.length} distinct profile(s): ${profiles.map((p) => p.profileKey).join(', ')}`);

  // 2. Load tracked config and cross-validate against the catalogue BEFORE
  //    touching Sharp. A stale config must fail loudly, not silently under-
  //    or over-produce derivatives.
  const config = loadConfig(productId);
  const coverageErrors = validateProfileCoverage(Object.keys(config.profiles), profiles);
  if (coverageErrors.length > 0) {
    throw new Error(`Profile coverage mismatch:\n  - ${coverageErrors.join('\n  - ')}`);
  }

  // 3. Read the source master's real dimensions and its sha256 (of the file
  //    bytes, not the decoded pixels — the manifest's sourceSha256 identifies
  //    the exact input file used).
  const sourceMeta = await sharp(resolvedSource).metadata();
  const sourceWidth = sourceMeta.width ?? 0;
  const sourceHeight = sourceMeta.height ?? 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error(`Could not decode source master dimensions: ${resolvedSource}`);
  }
  const sourceBytes = fs.readFileSync(resolvedSource);
  const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  console.log(`  source dimensions: ${sourceWidth}x${sourceHeight}  sha256: ${sourceSha256.slice(0, 12)}…`);

  // 4. Validate every profile's configured crop BEFORE generating anything —
  //    fail on the first bad crop rather than partially writing derivatives.
  for (const profile of profiles) {
    const configured = config.profiles[profile.profileKey];
    validateCropAspect(configured.crop, { w: profile.w, h: profile.h });
    validateNoEnlargement(configured.crop, { w: profile.w, h: profile.h });
    if (
      configured.crop.left < 0 ||
      configured.crop.top < 0 ||
      configured.crop.left + configured.crop.width > sourceWidth ||
      configured.crop.top + configured.crop.height > sourceHeight
    ) {
      throw new Error(
        `Profile ${profile.profileKey}: configured crop {left:${configured.crop.left}, top:${configured.crop.top}, ` +
          `width:${configured.crop.width}, height:${configured.crop.height}} exceeds source bounds ${sourceWidth}x${sourceHeight}`,
      );
    }
  }
  console.log('  all crops validated (aspect match, no enlargement, within source bounds)');

  const outputDir = path.join(ROOT, 'design', 'print-assets', productId, revision);
  refuseOverwrite(outputDir, { exists: () => fs.existsSync(outputDir), force });

  if (dryRun) {
    console.log('\nDRY RUN — no derivatives generated, no files written.');
    console.log(`Would write ${profiles.length} derivative(s) + manifest.json to ${path.relative(ROOT, outputDir)}/`);
    return;
  }

  // 5. Generate one derivative per distinct profile. When --force reuses an
  //    existing revision dir, clear it first so a changed crop config can't
  //    leave stale {profile}-{oldSha256}.{ext} files beside the new manifest.
  const derivativeMeta: Record<string, { sha256: string; byteSize: number; format: DerivativeFormat }> = {};
  prepareOutputDir(outputDir, { force });

  for (const profile of profiles) {
    const configured = config.profiles[profile.profileKey];
    process.stdout.write(`  generating ${profile.profileKey}.${configured.format} … `);
    const result = await generateDerivative(resolvedSource, configured.crop, profile.w, profile.h, configured.format);
    const filename = `${profile.profileKey}-${result.sha256}.${configured.format}`;
    writeDerivative(path.join(outputDir, filename), result.buffer);
    derivativeMeta[profile.profileKey] = { sha256: result.sha256, byteSize: result.byteSize, format: result.format };
    console.log(`${(result.byteSize / 1024).toFixed(0)} KB → ${filename}`);

    // Review proof — small, visual-only, never a fulfilment asset, never
    // uploaded (manifest.json's `derivatives` list never references it).
    const proofPath = path.join(outputDir, `proof-${profile.profileKey}.jpg`);
    await sharp(result.buffer).resize({ width: 600 }).jpeg({ quality: 70 }).toFile(proofPath);
  }

  // 6. Build + validate the manifest, then write it.
  const manifest = buildManifest({
    product: productId,
    revision,
    sourceSha256,
    sourceWidth,
    sourceHeight,
    profiles,
    derivativeMeta,
  });
  const manifestErrors = validateManifest(manifest, config);
  if (manifestErrors.length > 0) {
    throw new Error(`Manifest failed validation (this indicates a bug in prepare, not a config problem):\n  - ${manifestErrors.join('\n  - ')}`);
  }
  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nDone. ${profiles.length} derivative(s) + manifest written to ${path.relative(ROOT, outputDir)}/`);
  console.log('Review the proof-*.jpg files before running print-assets:upload (Phase 2b).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
