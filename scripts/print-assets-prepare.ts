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
 * proportional layout config (fractions, placement fit, no upscale) against
 * every profile, resolves a placement per profile via the lib math, composes
 * exact-size derivatives via Sharp, and writes a schema-v2 manifest that Phase
 * 2b (upload/verify/publish) consumes.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars /
 * env) and that `npm run catalog:backfill` has seeded `products` /
 * `product_variants` for the product.
 *
 * Usage:
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1 --force
 *   npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1 --dry-run
 *
 * Output (gitignored): design/print-assets/{productId}/{revision}/
 *   - {profileKey}-{sha256}.{jpg|png} per distinct profile
 *   - manifest.json (the Phase 2b contract — see src/lib/print-assets-prepare.ts)
 *   - proof-{profileKey}.jpg — small (600px-wide) contact-sheet-style review proof
 *     per profile; visual review only, NEVER uploaded to R2.
 *
 * Read-only on R2 (upload is 2b's job). No DB writes (publish is a separate
 * script + the atomic RPC).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  assertSourceMatchesRatio,
  buildFullBleedManifest,
  buildManifest,
  distinctProfiles,
  FULL_BLEED_LAYOUT,
  parsePrepareManifest,
  ratioForProfile,
  resolvePlacement,
  validateLayoutFractions,
  validateNoUpscale,
  validatePlacement,
  type DerivativeFormat,
  type DerivativeProfile,
  type Placement,
  type PrintRatio,
} from '../src/lib/print-assets-prepare';
import {
  composeDerivative,
  composeFullBleedDerivative,
  prepareOutputDir,
  validateSignatureSvg,
  writeDerivative,
} from './lib/prepare-derivatives';
import { activeVariantDimensions } from './lib/db-variants';
import { loadSupabaseClient } from './lib/script-env';
import {
  isFullBleedConfig,
  loadPrepareConfig,
  parseScriptArgs,
  PRINT_ASSET_ARG_SPECS,
  revisionDir,
  ROOT,
  type LoadedFullBleedPrepareConfig,
} from './lib/print-assets-cli';

/**
 * FullBleed mode's `prepare`: no background/layout/artwork/signature — one
 * per-ratio master resized directly to each profile's exact pixels (never
 * cropped). Every profile's source is validated (ratio match + no upscale)
 * before ANY composing, same fail-closed-up-front shape as the poster path.
 */
async function prepareFullBleed(
  productId: string,
  revision: string,
  config: LoadedFullBleedPrepareConfig,
  profiles: DerivativeProfile[],
  options: { force: boolean; dryRun: boolean },
): Promise<void> {
  const { value: composition, sha256: configSha256, sources } = config;
  console.log('  mode: fullBleed');

  const ratioForProfileKey = new Map<string, PrintRatio>();
  const neededRatios = new Set<PrintRatio>();
  for (const profile of profiles) {
    const ratio = ratioForProfile(profile.w, profile.h);
    ratioForProfileKey.set(profile.profileKey, ratio);
    neededRatios.add(ratio);
  }

  // Decode + hash each distinct source once, validate ratio match, before any compose.
  const sourceInfo = new Map<
    PrintRatio,
    { absolutePath: string; manifestPath: string; sha256: string; width: number; height: number }
  >();
  for (const ratio of neededRatios) {
    const source = sources[ratio];
    if (!fs.existsSync(source.absolutePath)) {
      throw new Error(
        `Full-bleed source not found for ratio "${ratio}": ${source.absolutePath} (config.sources.${ratio} = ${source.manifestPath})`,
      );
    }
    const meta = await sharp(source.absolutePath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width === 0 || height === 0) {
      throw new Error(`Could not decode full-bleed source dimensions for ratio "${ratio}": ${source.absolutePath}`);
    }
    assertSourceMatchesRatio(ratio, { w: width, h: height });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(source.absolutePath)).digest('hex');
    sourceInfo.set(ratio, { absolutePath: source.absolutePath, manifestPath: source.manifestPath, sha256, width, height });
    console.log(`  source ${ratio}: ${source.absolutePath}  ${width}x${height}  sha256: ${sha256.slice(0, 12)}…`);
  }

  const layoutErrors: string[] = [];
  for (const profile of profiles) {
    const info = sourceInfo.get(ratioForProfileKey.get(profile.profileKey)!)!;
    layoutErrors.push(
      ...validateNoUpscale(FULL_BLEED_LAYOUT, { w: profile.w, h: profile.h }, { w: info.width, h: info.height }, false),
    );
  }
  if (layoutErrors.length > 0) {
    throw new Error(`Full-bleed sources do not cover every profile:\n  - ${layoutErrors.join('\n  - ')}`);
  }
  console.log('  sources validated (ratio match + no upscale across all profiles)');

  const outputDir = revisionDir(productId, revision);

  if (options.dryRun) {
    console.log('\nDRY RUN — no derivatives generated, no files written.');
    console.log(`Would compose ${profiles.length} derivative(s) + manifest.json to ${path.relative(ROOT, outputDir)}/`);
    return;
  }

  const derivativeMeta: Record<
    string,
    {
      sha256: string;
      byteSize: number;
      format: DerivativeFormat;
      source: { ratio: PrintRatio; path: string; sha256: string; width: number; height: number };
    }
  > = {};
  prepareOutputDir(outputDir, { force: options.force });

  for (const profile of profiles) {
    const ratio = ratioForProfileKey.get(profile.profileKey)!;
    const info = sourceInfo.get(ratio)!;
    process.stdout.write(`  composing ${profile.profileKey}.${composition.format} (${ratio}) … `);
    const result = await composeFullBleedDerivative({
      sourcePath: info.absolutePath,
      target: { w: profile.w, h: profile.h },
      format: composition.format,
    });
    const filename = `${profile.profileKey}-${result.sha256}.${composition.format}`;
    writeDerivative(path.join(outputDir, filename), result.buffer);
    derivativeMeta[profile.profileKey] = {
      sha256: result.sha256,
      byteSize: result.byteSize,
      format: result.format,
      source: { ratio, path: info.manifestPath, sha256: info.sha256, width: info.width, height: info.height },
    };
    console.log(`${(result.byteSize / 1024).toFixed(0)} KB → ${filename}`);

    const proofPath = path.join(outputDir, `proof-${profile.profileKey}.jpg`);
    await sharp(result.buffer).resize({ width: 600 }).jpeg({ quality: 70 }).toFile(proofPath);
  }

  const manifest = buildFullBleedManifest({
    product: productId,
    revision,
    configSha256,
    profiles,
    derivativeMeta,
  });
  try {
    parsePrepareManifest(manifest);
  } catch (error) {
    throw new Error(
      `Manifest failed self-validation (this indicates a bug in prepare, not a config problem): ` +
        `${error instanceof Error ? error.message : error}`,
    );
  }
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nDone. ${profiles.length} derivative(s) + manifest written to ${path.relative(ROOT, outputDir)}/`);
  console.log('Review the proof-*.jpg files before running print-assets:upload (Phase 2b).');
}

async function main(): Promise<void> {
  const args = parseScriptArgs(PRINT_ASSET_ARG_SPECS.prepare);
  const productId = args.product;
  const revision = args.revision;
  const force = args.force === true;
  const dryRun = args['dry-run'] === true;

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-17-r1)');

  console.log(`print-assets:prepare — product=${productId} revision=${revision}`);

  // Validated, hashed config with resolved (traversal-checked) source paths.
  const config = loadPrepareConfig(productId);

  if (isFullBleedConfig(config)) {
    const supabase = loadSupabaseClient();
    const variantDims = await activeVariantDimensions(supabase, productId);
    const profiles = distinctProfiles(variantDims);
    console.log(
      `  ${variantDims.length} active variant(s) → ${profiles.length} distinct profile(s): ` +
        `${profiles.map((p) => p.profileKey).join(', ')}`,
    );
    await prepareFullBleed(productId, revision, config, profiles, { force, dryRun });
    return;
  }

  const { value: composition, sha256: configSha256, artwork, signature } = config;

  if (!fs.existsSync(artwork.absolutePath)) {
    throw new Error(`Artwork master not found: ${artwork.absolutePath} (config.artwork = ${artwork.manifestPath})`);
  }
  if (signature && !fs.existsSync(signature.absolutePath)) {
    throw new Error(`Signature SVG not found: ${signature.absolutePath} (config.signature.svg = ${signature.manifestPath})`);
  }
  const hasSignature = signature !== null;
  console.log(`  artwork: ${artwork.absolutePath}`);
  console.log(`  signature: ${signature?.absolutePath ?? '(none)'}`);

  // 1. Validate layout fractions before any per-profile work.
  const fractionErrors = validateLayoutFractions(composition.layout);
  if (fractionErrors.length > 0) {
    throw new Error(`Invalid layout fractions:\n  - ${fractionErrors.join('\n  - ')}`);
  }

  if (signature) await validateSignatureSvg(signature.absolutePath);

  // 2. Enumerate active variants → distinct dimension profiles.
  const supabase = loadSupabaseClient();
  const variantDims = await activeVariantDimensions(supabase, productId);
  const profiles = distinctProfiles(variantDims);
  console.log(
    `  ${variantDims.length} active variant(s) → ${profiles.length} distinct profile(s): ` +
      `${profiles.map((p) => p.profileKey).join(', ')}`,
  );

  // 3. Read the artwork master's dimensions + sha256.
  const sourceMeta = await sharp(artwork.absolutePath).metadata();
  const sourceWidth = sourceMeta.width ?? 0;
  const sourceHeight = sourceMeta.height ?? 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error(`Could not decode artwork master dimensions: ${artwork.absolutePath}`);
  }
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(artwork.absolutePath)).digest('hex');
  const signatureSha256 = signature
    ? crypto.createHash('sha256').update(fs.readFileSync(signature.absolutePath)).digest('hex')
    : null;
  console.log(`  artwork dimensions: ${sourceWidth}x${sourceHeight}  sha256: ${sourceSha256.slice(0, 12)}…`);

  // 4. Resolve + validate a placement (fit + no upscale) for EVERY profile before composing.
  const placements = new Map<string, Placement>();
  const layoutErrors: string[] = [];
  for (const profile of profiles) {
    const placement = resolvePlacement(
      composition.layout,
      { w: profile.w, h: profile.h },
      { w: sourceWidth, h: sourceHeight },
      hasSignature,
    );
    placements.set(profile.profileKey, placement);
    layoutErrors.push(
      ...validatePlacement(placement, { w: profile.w, h: profile.h }),
      ...validateNoUpscale(composition.layout, { w: profile.w, h: profile.h }, { w: sourceWidth, h: sourceHeight }, hasSignature),
    );
  }
  if (layoutErrors.length > 0) {
    throw new Error(`Layout does not fit every profile:\n  - ${layoutErrors.join('\n  - ')}`);
  }
  console.log('  layout validated (placement fit + no upscale across all profiles)');

  const outputDir = revisionDir(productId, revision);

  if (dryRun) {
    console.log('\nDRY RUN — no derivatives generated, no files written.');
    console.log(`Would compose ${profiles.length} derivative(s) + manifest.json to ${path.relative(ROOT, outputDir)}/`);
    return;
  }

  // 5. Compose one derivative per distinct profile (fails closed on an existing dir without --force).
  const derivativeMeta: Record<string, { sha256: string; byteSize: number; format: DerivativeFormat; placement: Placement }> = {};
  prepareOutputDir(outputDir, { force });

  for (const profile of profiles) {
    const placement = placements.get(profile.profileKey)!;
    process.stdout.write(`  composing ${profile.profileKey}.${composition.format} … `);
    const result = await composeDerivative({
      artworkPath: artwork.absolutePath,
      signatureSvgPath: signature?.absolutePath ?? null,
      background: composition.background,
      placement,
      target: { w: profile.w, h: profile.h },
      format: composition.format,
    });
    const filename = `${profile.profileKey}-${result.sha256}.${composition.format}`;
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

  // 6. Build + self-validate the schema-v2 manifest, then write it.
  const manifest = buildManifest({
    product: productId,
    revision,
    configSha256,
    background: composition.background,
    layout: composition.layout,
    artworkManifestPath: artwork.manifestPath,
    artworkSha256: sourceSha256,
    artworkWidth: sourceWidth,
    artworkHeight: sourceHeight,
    signatureManifestPath: signature?.manifestPath ?? null,
    signatureSha256,
    profiles,
    derivativeMeta,
  });
  try {
    parsePrepareManifest(manifest);
  } catch (error) {
    throw new Error(
      `Manifest failed self-validation (this indicates a bug in prepare, not a config problem): ` +
        `${error instanceof Error ? error.message : error}`,
    );
  }
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nDone. ${profiles.length} derivative(s) + manifest written to ${path.relative(ROOT, outputDir)}/`);
  console.log('Review the proof-*.jpg files before running print-assets:upload (Phase 2b).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
