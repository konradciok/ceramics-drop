/**
 * Batch-onboard new fine-art-print designs from a manifest + an intake folder
 * of already-upscaled (e.g. Lightroom Super Resolution) artwork exports —
 * Phase 0 of the print-fulfilment pipeline, run BEFORE `print-assets:prepare`
 * ever touches a design. Never uploads anything and never writes the DB.
 *
 * Reads `config/print-assets/onboarding-manifest.json` (or `--manifest
 * <path>`); per row:
 *   1. confirms `design/print-assets/_incoming/{incomingFile}` decodes and
 *      clears the resolution floor for EVERY variant the row will offer
 *      (same contain-scale math `print-assets:prepare` itself enforces —
 *      this only validates an already-upscaled export, it never upscales);
 *   2. on pass, and unless `--dry-run`: copies the master to
 *      `design/print-assets/{id}/artwork-master.jpg`, copies the one shared
 *      artist signature (`design/print-assets/_shared/signature.svg`) to
 *      `design/print-assets/{id}/signature.svg`, and writes
 *      `config/print-assets/{id}.json`.
 * A design whose `design/print-assets/{id}/` already exists is skipped
 * unless `--force` (mirrors `prepare`'s own overwrite gate).
 *
 * Always writes `design/print-assets/_incoming/generated-prints-entries.ts`
 * — paste those `PrintDesign` object literals into `src/lib/prints.ts` by
 * hand. This script never rewrites that file itself: it's hand-maintained
 * with inline comments an automatic AST edit could easily mangle.
 *
 * Usage:
 *   npm run print-assets:onboard -- --dry-run
 *   npm run print-assets:onboard
 *   npm run print-assets:onboard -- --manifest path/to/manifest.json --force
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { assertSourceMatchesRatio, distinctProfiles, FULL_BLEED_LAYOUT, ratioForProfile, PRINT_RATIOS, type PrintRatio } from '../src/lib/print-assets-prepare';
import {
  onboardingManifestSchema,
  deriveSourceProfile,
  defaultMasterFolder,
  expectedVariantDimensions,
  buildPrepareConfig,
  buildPrintDesignEntry,
  ONBOARD_LAYOUT,
  FULL_AXES,
  type FullBleedOnboardingRow,
  type PosterOnboardingRow,
} from '../src/lib/print-assets-onboard';
import { masterScaleReport, requiredMasterScale } from '../src/lib/print-assets-master-scale';
import { parseScriptArgs, PRINT_ASSET_ARG_SPECS, ROOT } from './lib/print-assets-cli';

const INCOMING_DIR = path.join(ROOT, 'design', 'print-assets', '_incoming');
const SHARED_SIGNATURE = path.join(ROOT, 'design', 'print-assets', '_shared', 'signature.svg');
const MASTER_IMAGES_ROOT = path.join(ROOT, 'design', 'uploads', 'master-images-prints');
const DEFAULT_MANIFEST = path.join(ROOT, 'config', 'print-assets', 'onboarding-manifest.json');
const GENERATED_ENTRIES_PATH = path.join(INCOMING_DIR, 'generated-prints-entries.ts');

type RowResult = { id: string; status: 'pass' | 'fail' | 'skip'; detail: string };

function designDir(id: string): string {
  return path.join(ROOT, 'design', 'print-assets', id);
}

function configPathFor(id: string): string {
  return path.join(ROOT, 'config', 'print-assets', `${id}.json`);
}

async function checkResolution(row: PosterOnboardingRow, incomingPath: string): Promise<string | null> {
  const meta = await sharp(incomingPath).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0) return `could not decode ${path.relative(ROOT, incomingPath)}`;

  const profiles = distinctProfiles(expectedVariantDimensions(row));
  const report = masterScaleReport(ONBOARD_LAYOUT, profiles, { w, h }, true);
  const maxScale = requiredMasterScale(report);
  if (maxScale > 1) {
    const worst = report.reduce((a, b) => (b.scale > a.scale ? b : a));
    return (
      `${w}x${h} is too small — needs ${worst.scale.toFixed(3)}x more for profile ${worst.profileKey} ` +
      `(box ${worst.box.width}x${worst.box.height})`
    );
  }
  return null;
}

/**
 * Validate a fullBleed row's four canonical per-ratio masters: each must
 * exist, decode, and resolve (via `ratioForProfile`) to the ratio its own
 * filename claims, and each ratio's master must cover — without upscale —
 * every profile that ratio serves (reuses `expectedVariantDimensions` +
 * `masterScaleReport`, the same resolution-floor math `checkResolution` uses
 * for poster rows).
 */
async function checkFullBleedResolution(row: FullBleedOnboardingRow): Promise<string | null> {
  const folder = row.masterFolder ?? defaultMasterFolder(row.id);
  const profiles = distinctProfiles(expectedVariantDimensions(FULL_AXES));
  const profilesByRatio = new Map<PrintRatio, typeof profiles>();
  for (const profile of profiles) {
    const ratio = ratioForProfile(profile.w, profile.h);
    profilesByRatio.set(ratio, [...(profilesByRatio.get(ratio) ?? []), profile]);
  }

  for (const ratio of PRINT_RATIOS) {
    const sourcePath = path.join(MASTER_IMAGES_ROOT, folder, `${folder}__${ratio}.jpg`);
    if (!fs.existsSync(sourcePath)) {
      return `missing ${path.relative(ROOT, sourcePath)}`;
    }
    const meta = await sharp(sourcePath).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w === 0 || h === 0) return `could not decode ${path.relative(ROOT, sourcePath)}`;
    try {
      assertSourceMatchesRatio(ratio, { w, h });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }

    const ratioProfiles = profilesByRatio.get(ratio) ?? [];
    const report = masterScaleReport(FULL_BLEED_LAYOUT, ratioProfiles, { w, h }, false);
    const maxScale = requiredMasterScale(report);
    if (maxScale > 1) {
      const worst = report.reduce((a, b) => (b.scale > a.scale ? b : a));
      return (
        `${folder}__${ratio}.jpg (${w}x${h}) is too small — needs ${worst.scale.toFixed(3)}x more for profile ` +
        `${worst.profileKey} (box ${worst.box.width}x${worst.box.height})`
      );
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseScriptArgs(PRINT_ASSET_ARG_SPECS.onboard);
  const manifestPath = args.manifest ? path.resolve(ROOT, args.manifest) : DEFAULT_MANIFEST;
  const dryRun = args['dry-run'] === true;
  const force = args.force === true;

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No manifest at ${path.relative(ROOT, manifestPath)}. Copy ` +
        `config/print-assets/onboarding-manifest.example.json and fill in your rows.`,
    );
  }
  const rows = onboardingManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`Duplicate id in manifest: ${row.id}`);
    seen.add(row.id);
  }

  console.log(
    `print-assets:onboard — ${rows.length} row(s) from ${path.relative(ROOT, manifestPath)}` +
      `${dryRun ? '  [DRY RUN]' : ''}`,
  );

  const results: RowResult[] = [];
  const generatedEntries: string[] = [];

  for (const row of rows) {
    if (row.style === 'fullBleed') {
      const resolutionError = await checkFullBleedResolution(row);
      if (resolutionError) {
        results.push({ id: row.id, status: 'fail', detail: resolutionError });
        continue;
      }

      const configPath = configPathFor(row.id);
      if (fs.existsSync(configPath) && !force) {
        results.push({
          id: row.id,
          status: 'skip',
          detail: `${path.relative(ROOT, configPath)} already exists (--force to overwrite)`,
        });
        generatedEntries.push(JSON.stringify(buildPrintDesignEntry(row), null, 2));
        continue;
      }

      const sourceProfile = deriveSourceProfile(FULL_AXES.sizes);
      generatedEntries.push(JSON.stringify(buildPrintDesignEntry(row), null, 2));

      if (dryRun) {
        results.push({ id: row.id, status: 'pass', detail: `would write ${path.relative(ROOT, configPath)}` });
        continue;
      }

      // Sources are already in their canonical design/uploads/master-images-prints/
      // home — fullBleed onboarding never copies masters, only points at them.
      const config = { _comment: `${row.title} — generated by print-assets:onboard`, ...buildPrepareConfig(row, sourceProfile) };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      results.push({ id: row.id, status: 'pass', detail: `wrote ${path.relative(ROOT, configPath)}` });
      continue;
    }

    const incomingPath = path.join(INCOMING_DIR, row.incomingFile);
    if (!fs.existsSync(incomingPath)) {
      results.push({ id: row.id, status: 'fail', detail: `missing ${path.relative(ROOT, incomingPath)}` });
      continue;
    }

    const resolutionError = await checkResolution(row, incomingPath);
    if (resolutionError) {
      results.push({ id: row.id, status: 'fail', detail: resolutionError });
      continue;
    }

    const targetDir = designDir(row.id);
    if (fs.existsSync(targetDir) && !force) {
      results.push({ id: row.id, status: 'skip', detail: `${path.relative(ROOT, targetDir)} already exists (--force to overwrite)` });
      generatedEntries.push(JSON.stringify(buildPrintDesignEntry(row), null, 2));
      continue;
    }

    const sourceProfile = deriveSourceProfile(row.sizes);
    generatedEntries.push(JSON.stringify(buildPrintDesignEntry(row), null, 2));

    if (dryRun) {
      results.push({ id: row.id, status: 'pass', detail: `would write ${path.relative(ROOT, targetDir)}/ + config` });
      continue;
    }

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(incomingPath, path.join(targetDir, 'artwork-master.jpg'));
    if (fs.existsSync(SHARED_SIGNATURE)) {
      fs.copyFileSync(SHARED_SIGNATURE, path.join(targetDir, 'signature.svg'));
    }

    const config = { _comment: `${row.title} — generated by print-assets:onboard`, ...buildPrepareConfig(row, sourceProfile) };
    const configPath = configPathFor(row.id);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    results.push({ id: row.id, status: 'pass', detail: `wrote ${path.relative(ROOT, targetDir)}/ + ${path.relative(ROOT, configPath)}` });
  }

  const entriesFile =
    `// Generated by print-assets:onboard — paste these into PRINT_DESIGNS in src/lib/prints.ts by hand.\n` +
    `// Every entry ships published: false; flip to true only once the full per-design pipeline\n` +
    `// (prepare -> upload -> verify -> publish -> gallery -> mockups) has run and been reviewed.\n\n` +
    generatedEntries.join(',\n') +
    '\n';
  // --dry-run writes nothing (per the usage header above); a fully failed/skipped
  // run has nothing new to report and must not blank out a previous good run's file.
  const writeEntries = !dryRun && generatedEntries.length > 0;
  if (writeEntries) {
    if (!fs.existsSync(INCOMING_DIR)) fs.mkdirSync(INCOMING_DIR, { recursive: true });
    fs.writeFileSync(GENERATED_ENTRIES_PATH, entriesFile);
  }

  console.log('\nResults:');
  for (const r of results) {
    console.log(`  [${r.status.toUpperCase().padEnd(4)}] ${r.id}  ${r.detail}`);
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed (of ${rows.length}).`);
  if (writeEntries) {
    console.log(`Registry entries written to ${path.relative(ROOT, GENERATED_ENTRIES_PATH)} — paste into src/lib/prints.ts.`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
