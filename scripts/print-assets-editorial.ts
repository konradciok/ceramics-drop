/**
 * Convert the 3 editorial/lifestyle source PNGs per fine-art-print design
 * (design/uploads/master-images-prints/print-{NNN}/print-{NNN}_mockup-0N.png)
 * into the storefront WebP set and mirror to public/uploads/ for srcSet()
 * delivery. No R2 upload — these are static storefront assets, not
 * fulfilment derivatives.
 *
 * Usage:
 *   npm run print-assets:editorial -- --product fap001 --dry-run
 *   npm run print-assets:editorial -- --product fap001
 *   npm run print-assets:editorial -- --all --dry-run
 *   npm run print-assets:editorial -- --all
 *
 * `--all` validates every design's source folder BEFORE converting anything
 * (missing files, wrong count, stray variants, orphan folders all fail the
 * whole run) — see `validateAll`. On a successful non-dry-run `--all` run it
 * also writes ready-to-paste `editorialGallery` registry snippets to
 * .superpowers/sdd/print-editorial-gallery-plan/generated-registry-snippets.txt.
 *
 * Plan: .superpowers/sdd/print-editorial-gallery-plan/ (Task 1 of 3 — this
 * script only; Tasks 2/3 run it for real and wire the output into the
 * registry/components).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registryPrintById, registryPrintDesigns } from '../src/lib/prints';
import type { PrintDesign } from '../src/lib/types';
import { parseScriptArgs, PRINT_ASSET_ARG_SPECS, ROOT } from './lib/print-assets-cli';
import { generateWebpSet } from './lib/print-assets-storefront';

const SOURCE_ROOT = path.join(ROOT, 'design', 'uploads', 'master-images-prints');
const SLIDE_COUNT = 3;
const SNIPPETS_PATH = path.join(
  ROOT,
  '.superpowers',
  'sdd',
  'print-editorial-gallery-plan',
  'generated-registry-snippets.txt',
);

interface SlideSource {
  slide: number; // 1..3
  filename: string;
  path: string;
}

interface DesignPlan {
  id: string;
  num3: string; // zero-padded 3-digit number, e.g. '001'
  folder: string; // print-001
  slides: SlideSource[]; // exactly 3, sorted by slide number
}

/** `fap001` → `001`. Registry ids are trusted (never raw CLI input) before this is called. */
function num3FromId(id: string): string {
  const match = /^fap(\d{3})$/.exec(id);
  if (!match) throw new Error(`Unexpected print design id "${id}" — expected fapNNN`);
  return match[1];
}

/**
 * Validate a single design's source folder: it must exist and contain
 * exactly 3 files matching `print-{num3}_mockup-0[1-3].png` — no more, no
 * fewer, no stray `_mockup-0N` variants outside 01-03. Returns the validated
 * slide plan on success, or every failure message found (never just the
 * first) on failure.
 */
function validateDesignFolder(design: PrintDesign): { plan: DesignPlan | null; failures: string[] } {
  const num3 = num3FromId(design.id);
  const folder = `print-${num3}`;
  const folderPath = path.join(SOURCE_ROOT, folder);

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return { plan: null, failures: [`missing folder ${folder}`] };
  }

  const files = fs.readdirSync(folderPath);
  const validPattern = new RegExp(`^print-${num3}_mockup-0([1-3])\\.png$`);
  const anyVariantPattern = new RegExp(`^print-${num3}_mockup-\\d+\\.png$`);

  const validMatches = files
    .map((f) => ({ f, m: validPattern.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null);

  const failures: string[] = [];

  const strayVariants = files.filter((f) => anyVariantPattern.test(f) && !validPattern.test(f)).sort();
  if (strayVariants.length > 0) {
    failures.push(`${folder} has stray mockup file(s): ${strayVariants.join(', ')}`);
  }

  if (validMatches.length !== SLIDE_COUNT) {
    const foundSlides = new Set(validMatches.map((x) => Number(x.m[1])));
    const missing = [1, 2, 3].filter((n) => !foundSlides.has(n));
    if (missing.length > 0) {
      failures.push(
        `${folder} missing ${missing.map((n) => `print-${num3}_mockup-0${n}.png`).join(', ')}`,
      );
    } else {
      failures.push(`${folder} has ${validMatches.length} mockup file(s), expected ${SLIDE_COUNT}`);
    }
  }

  if (failures.length > 0) return { plan: null, failures };

  const slides: SlideSource[] = validMatches
    .map((x) => ({ slide: Number(x.m[1]), filename: x.f, path: path.join(folderPath, x.f) }))
    .sort((a, b) => a.slide - b.slide);

  return { plan: { id: design.id, num3, folder, slides }, failures: [] };
}

/**
 * Full-batch validation: every registry design's folder (via
 * `validateDesignFolder`) plus a scan for orphan `print-XXX` folders with no
 * matching registry id. Runs to completion and collects every failure
 * regardless of where it occurred — never stops at the first.
 */
function validateAll(
  designs: PrintDesign[],
): { plans: DesignPlan[]; designFailures: Map<string, string[]>; orphanFailures: string[] } {
  if (!fs.existsSync(SOURCE_ROOT)) {
    throw new Error(`Source root not found: ${path.relative(ROOT, SOURCE_ROOT)}`);
  }

  const actualFolders = fs
    .readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^print-\d{3}$/.test(name));

  const expectedFolders = new Set(designs.map((d) => `print-${num3FromId(d.id)}`));
  const orphanFailures = actualFolders
    .filter((f) => !expectedFolders.has(f))
    .sort()
    .map((f) => `orphan folder ${f} has no matching registry id`);

  const plans: DesignPlan[] = [];
  const designFailures = new Map<string, string[]>();
  for (const design of designs) {
    const { plan, failures } = validateDesignFolder(design);
    if (plan) plans.push(plan);
    if (failures.length > 0) designFailures.set(design.id, failures);
  }

  return { plans, designFailures, orphanFailures };
}

/** WebP stem for one slide: `fap-{num3}-life-{01,02,03}`. */
function slideStem(num3: string, slide: number): string {
  return `fap-${num3}-life-${String(slide).padStart(2, '0')}`;
}

/** Generate the WebP set for every slide of one design and write/report each file. */
async function convertDesign(plan: DesignPlan, dryRun: boolean, scratchDir: string): Promise<void> {
  for (const slide of plan.slides) {
    const stem = slideStem(plan.num3, slide.slide);
    const pngBuffer = fs.readFileSync(slide.path);
    const webps = await generateWebpSet(pngBuffer, stem, scratchDir);
    for (const file of webps) {
      const sizeKb = (fs.statSync(file.localPath).size / 1024).toFixed(0);
      if (dryRun) {
        console.log(`  would write public${file.publicPath} (${sizeKb} KB)`);
        continue;
      }
      fs.copyFileSync(file.localPath, path.join(ROOT, 'public', file.publicPath));
      console.log(`  ${file.filename} → ${file.publicPath} (${sizeKb} KB)`);
    }
  }
}

/** `editorialGallery` snippet block for one design, in registry order. */
function designSnippet(plan: DesignPlan): string {
  const urls = plan.slides.map((s) => `/uploads/${slideStem(plan.num3, s.slide)}.webp`);
  return `// ${plan.id}\neditorialGallery: [${urls.map((u) => `'${u}'`).join(', ')}],`;
}

function writeSnippets(plans: DesignPlan[]): void {
  const content = `${plans.map(designSnippet).join('\n\n')}\n`;
  fs.mkdirSync(path.dirname(SNIPPETS_PATH), { recursive: true });
  fs.writeFileSync(SNIPPETS_PATH, content, 'utf8');
  console.log(`\nWrote ${path.relative(ROOT, SNIPPETS_PATH)}:\n`);
  console.log(content);
}

async function main(): Promise<void> {
  const args = parseScriptArgs(PRINT_ASSET_ARG_SPECS.editorial);
  const productId = args.product;
  const all = args.all === true;
  const dryRun = args['dry-run'] === true;

  if (all === Boolean(productId)) {
    throw new Error('Pass exactly one of --product <id> or --all');
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-editorial-'));
  try {
    let plans: DesignPlan[];

    if (all) {
      const designs = registryPrintDesigns();
      console.log(`Validating ${designs.length} design(s) against ${path.relative(ROOT, SOURCE_ROOT)}...`);
      const { plans: validPlans, designFailures, orphanFailures } = validateAll(designs);

      let passed = 0;
      let failed = 0;
      for (const design of designs) {
        const messages = designFailures.get(design.id);
        if (messages) {
          failed += 1;
          console.log(`[FAIL] ${design.id} ${messages.join('; ')}`);
        } else {
          passed += 1;
          console.log(`[OK] ${design.id} 3/3 slides`);
        }
      }
      for (const message of orphanFailures) {
        console.log(`[FAIL] ${message}`);
      }

      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed > 0 || orphanFailures.length > 0) {
        throw new Error(
          `Validation failed: ${failed} design(s) failed` +
            (orphanFailures.length > 0 ? `, ${orphanFailures.length} orphan folder(s)` : ''),
        );
      }

      plans = validPlans;
    } else {
      const design = registryPrintById(productId!);
      if (!design) throw new Error(`Unknown print design "${productId}"`);
      const { plan, failures } = validateDesignFolder(design);
      if (!plan) {
        console.log(`[FAIL] ${design.id} ${failures.join('; ')}`);
        throw new Error(`Validation failed for ${design.id}: ${failures.join('; ')}`);
      }
      console.log(`[OK] ${design.id} 3/3 slides`);
      plans = [plan];
    }

    for (const plan of plans) {
      console.log(`\n${plan.id} (${plan.folder}):`);
      await convertDesign(plan, dryRun, scratchDir);
    }

    if (all && !dryRun) {
      writeSnippets(plans);
    }

    console.log(
      `\nDone. ${plans.length} design(s) converted.` +
        (dryRun ? ' [DRY RUN]' : ' Commit public/uploads/fap-*-life-*.webp together with the registry update.'),
    );
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
