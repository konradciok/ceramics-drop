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
import { distinctProfiles } from '../src/lib/print-assets-prepare';
import {
  onboardingManifestSchema,
  deriveSourceProfile,
  expectedVariantDimensions,
  buildPrepareConfig,
  buildPrintDesignEntry,
  ONBOARD_LAYOUT,
  type OnboardingRow,
} from '../src/lib/print-assets-onboard';
import { masterScaleReport, requiredMasterScale } from '../src/lib/print-assets-master-scale';
import { parseScriptArgs, PRINT_ASSET_ARG_SPECS, ROOT } from './lib/print-assets-cli';

const INCOMING_DIR = path.join(ROOT, 'design', 'print-assets', '_incoming');
const SHARED_SIGNATURE = path.join(ROOT, 'design', 'print-assets', '_shared', 'signature.svg');
const DEFAULT_MANIFEST = path.join(ROOT, 'config', 'print-assets', 'onboarding-manifest.json');
const GENERATED_ENTRIES_PATH = path.join(INCOMING_DIR, 'generated-prints-entries.ts');

type RowResult = { id: string; status: 'pass' | 'fail' | 'skip'; detail: string };

function designDir(id: string): string {
  return path.join(ROOT, 'design', 'print-assets', id);
}

async function checkResolution(row: OnboardingRow, incomingPath: string): Promise<string | null> {
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
    const configPath = path.join(ROOT, 'config', 'print-assets', `${row.id}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    results.push({ id: row.id, status: 'pass', detail: `wrote ${path.relative(ROOT, targetDir)}/ + ${path.relative(ROOT, configPath)}` });
  }

  if (!fs.existsSync(INCOMING_DIR)) fs.mkdirSync(INCOMING_DIR, { recursive: true });
  const entriesFile =
    `// Generated by print-assets:onboard — paste these into PRINT_DESIGNS in src/lib/prints.ts by hand.\n` +
    `// Every entry ships published: false; flip to true only once the full per-design pipeline\n` +
    `// (prepare -> upload -> verify -> publish -> gallery -> mockups) has run and been reviewed.\n\n` +
    generatedEntries.join(',\n') +
    '\n';
  if (!dryRun) fs.writeFileSync(GENERATED_ENTRIES_PATH, entriesFile);

  console.log('\nResults:');
  for (const r of results) {
    console.log(`  [${r.status.toUpperCase().padEnd(4)}] ${r.id}  ${r.detail}`);
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed (of ${rows.length}).`);
  if (!dryRun) {
    console.log(`Registry entries written to ${path.relative(ROOT, GENERATED_ENTRIES_PATH)} — paste into src/lib/prints.ts.`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
