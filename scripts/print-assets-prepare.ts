/**
 * Prepare deterministic Prodigi print-area derivatives from one approved
 * local artwork master (Phase 2a of the print asset pipeline —
 * docs/plans/print-asset-pipeline.md → Phase 2, `prepare` bullets, Settled
 * Architecture §1).
 *
 * Enumerates a print product's active DB variants (`product_variants.active`
 * — the same source of truth `publish_print_asset_revision` and
 * `getPrintAssetReadiness` check, not the code registry), deduplicates them
 * into distinct print-area dimension profiles, validates the tracked
 * proportional layout config (fractions, vertical fit, no upscale) against
 * every profile, resolves a placement per profile via the lib math, composes
 * exact-size derivatives via Sharp, and writes a manifest that Phase 2b
 * (upload/verify/publish — scripts/print-assets-{upload,verify,publish}.ts)
 * consumes.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars /
 * env) and that `npm run catalog:backfill` has seeded `products` /
 * `product_variants` for the product.
 *
 * Usage:
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1 --force
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1 --dry-run
 *   # --source overrides config.artwork (CLI parity); resolved from config if absent
 *
 * Output (gitignored): design/print-assets/{productId}/{revision}/
 *   - {profileKey}-{sha256}.{jpg|png} per distinct profile
 *   - manifest.json (the Phase 2b contract — see src/lib/print-assets-prepare.ts)
 *   - proof-{profileKey}.jpg — small (600px-wide) contact-sheet-style review proof
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
import {
  buildManifest,
  distinctProfiles,
  refuseOverwrite,
  resolvePlacement,
  validateLayoutFractions,
  validateManifest,
  validateNoUpscale,
  validatePlacementFit,
  validatePrepareConfig,
  type DerivativeFormat,
  type Placement,
  type PrepareConfig,
} from '../src/lib/print-assets-prepare';
import { composeDerivative, prepareOutputDir, validateSignatureSvg, writeDerivative } from './lib/prepare-derivatives';
import { activeVariantDimensions } from './lib/db-variants';
import { loadSupabaseClient } from './lib/script-env';
import { getArg, hasFlag, revisionDir, ROOT } from './lib/print-assets-cli';

/** Load config/print-assets/{productId}.json. Fails loudly if missing/malformed. */
function loadConfig(productId: string): PrepareConfig {
  const configPath = path.join(ROOT, 'config', 'print-assets', `${productId}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No tracked config for product "${productId}" — expected ${path.relative(ROOT, configPath)}. ` +
        'Author it first: artwork path, background, format, and a proportional layout ' +
        '(see docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md).',
    );
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const errors = validatePrepareConfig(parsed, productId);
  if (errors.length > 0) {
    throw new Error(`Invalid prepare config ${configPath}:\n  - ${errors.join('\n  - ')}`);
  }
  return parsed as PrepareConfig;
}

async function main(): Promise<void> {
  const productId = getArg('product');
  const revision = getArg('revision');
  const sourcePath = getArg('source'); // accepted for CLI parity; resolved from config.artwork if absent
  const force = hasFlag('force');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-17-r1)');

  console.log(`print-assets:prepare — product=${productId} revision=${revision}`);

  const config = loadConfig(productId);

  const artworkPath = sourcePath ? path.resolve(sourcePath) : path.resolve(ROOT, config.artwork);
  if (!fs.existsSync(artworkPath)) {
    throw new Error(`Artwork master not found: ${artworkPath} (config.artwork = ${config.artwork})`);
  }
  const signaturePath = config.signature ? path.resolve(ROOT, config.signature.svg) : null;
  if (signaturePath && !fs.existsSync(signaturePath)) {
    throw new Error(`Signature SVG not found: ${signaturePath} (config.signature.svg = ${config.signature!.svg})`);
  }
  const hasSignature = signaturePath !== null;
  console.log(`  artwork: ${artworkPath}`);
  console.log(`  signature: ${signaturePath ?? '(none)'}`);

  // 1. Validate layout fractions before any per-profile work.
  const fractionErrors = validateLayoutFractions(config.layout);
  if (fractionErrors.length > 0) {
    throw new Error(`Invalid layout fractions:\n  - ${fractionErrors.join('\n  - ')}`);
  }

  if (signaturePath) await validateSignatureSvg(signaturePath);

  // 2. Enumerate active variants → distinct dimension profiles.
  const supabase = loadSupabaseClient();
  const variantDims = await activeVariantDimensions(supabase, productId);
  const profiles = distinctProfiles(variantDims);
  console.log(`  ${variantDims.length} active variant(s) → ${profiles.length} distinct profile(s): ${profiles.map((p) => p.profileKey).join(', ')}`);

  // 3. Read the artwork master's dimensions + sha256.
  const sourceMeta = await sharp(artworkPath).metadata();
  const sourceWidth = sourceMeta.width ?? 0;
  const sourceHeight = sourceMeta.height ?? 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error(`Could not decode artwork master dimensions: ${artworkPath}`);
  }
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(artworkPath)).digest('hex');
  const signatureSha256 = signaturePath
    ? crypto.createHash('sha256').update(fs.readFileSync(signaturePath)).digest('hex')
    : null;
  console.log(`  artwork dimensions: ${sourceWidth}x${sourceHeight}  sha256: ${sourceSha256.slice(0, 12)}…`);

  // 4. Validate vertical fit + no-upscale for EVERY profile before composing.
  const layoutErrors: string[] = [];
  for (const profile of profiles) {
    layoutErrors.push(
      ...validatePlacementFit(config.layout, { w: profile.w, h: profile.h }, hasSignature),
      ...validateNoUpscale(config.layout, { w: profile.w, h: profile.h }, { w: sourceWidth, h: sourceHeight }, hasSignature),
    );
  }
  if (layoutErrors.length > 0) {
    throw new Error(`Layout does not fit every profile:\n  - ${layoutErrors.join('\n  - ')}`);
  }
  console.log('  layout validated (vertical fit + no upscale across all profiles)');

  const outputDir = revisionDir(productId, revision);
  refuseOverwrite(outputDir, { exists: () => fs.existsSync(outputDir), force });

  if (dryRun) {
    console.log('\nDRY RUN — no derivatives generated, no files written.');
    console.log(`Would compose ${profiles.length} derivative(s) + manifest.json to ${path.relative(ROOT, outputDir)}/`);
    return;
  }

  // 5. Compose one derivative per distinct profile.
  const derivativeMeta: Record<string, { sha256: string; byteSize: number; format: DerivativeFormat; placement: Placement }> = {};
  prepareOutputDir(outputDir, { force });

  for (const profile of profiles) {
    const placement = resolvePlacement(config.layout, { w: profile.w, h: profile.h }, { w: sourceWidth, h: sourceHeight }, hasSignature);
    process.stdout.write(`  composing ${profile.profileKey}.${config.format} … `);
    const result = await composeDerivative({
      artworkPath,
      signatureSvgPath: signaturePath,
      background: config.background,
      placement,
      target: { w: profile.w, h: profile.h },
      format: config.format,
    });
    const filename = `${profile.profileKey}-${result.sha256}.${config.format}`;
    writeDerivative(path.join(outputDir, filename), result.buffer);
    derivativeMeta[profile.profileKey] = {
      sha256: result.sha256,
      byteSize: result.byteSize,
      format: result.format,
      placement,
    };
    console.log(`${(result.byteSize / 1024).toFixed(0)} KB → ${filename}`);

    // Review proof — small, visual-only, never uploaded.
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
    signatureSha256,
    layout: config.layout,
    background: config.background,
    hasSignature,
    profiles,
    derivativeMeta,
  });
  const manifestErrors = validateManifest(manifest, config);
  if (manifestErrors.length > 0) {
    throw new Error(`Manifest failed validation (this indicates a bug in prepare, not a config problem):\n  - ${manifestErrors.join('\n  - ')}`);
  }
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nDone. ${profiles.length} derivative(s) + manifest written to ${path.relative(ROOT, outputDir)}/`);
  console.log('Review the proof-*.jpg files before running print-assets:upload (Phase 2b).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
