/**
 * Compose configurator mockup WebPs (framed / framed+mount × colour) for a
 * print design from its published fulfilment derivatives + shared frame
 * masters, upload to R2 under prints/{productId}/gallery/mock-{state}/ and
 * mirror to public/uploads/ for srcSet() delivery.
 *
 * Usage:
 *   npm run print-assets:mockups -- --product fap01
 *   npm run print-assets:mockups -- --product fap01 --state framed-black --dry-run
 *   npm run print-assets:mockups -- --product fap01 --revision 2026-07-12-r1
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, Wrangler R2 access,
 * config/print-assets/frames.json and the frame masters it points at.
 * Spec: docs/superpowers/specs/2026-07-19-print-configurator-live-mockup-design.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registryPrintById } from '../src/lib/prints';
import { designMockupStates, type MockupState } from '../src/lib/print-mockups';
import { composeMockup, type MockupWindow } from '../src/lib/print-mockups-compose';
import type { PrintFrameColour } from '../src/lib/types';
import { getArg, hasFlag, ROOT } from './lib/print-assets-cli';
import { galleryR2Key, resolveLatestReadyAsset } from './lib/print-assets-resolve';
import { generateWebpSet, resolveSourcePath } from './lib/print-assets-storefront';
import { printAssetsBucket, r2Put } from './lib/r2';

/** Canonical 7:10 sources (spec decision 2): FAP sheet / CFPM aperture. */
const SOURCE_PROFILE = { framed: '8400x12000', mount: '7200x10800' } as const;
const OUT_WIDTH = 2000;

interface FrameLayer {
  file: string;
  window: MockupWindow;
}
interface FramesConfig {
  background: string;
  frames: Partial<Record<PrintFrameColour, { framed: FrameLayer; mount?: FrameLayer }>>;
}

function loadFramesConfig(): FramesConfig {
  const p = path.join(ROOT, 'config', 'print-assets', 'frames.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      'Missing config/print-assets/frames.json — copy frames.example.json and point it at the frame masters.',
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as FramesConfig;
}

function frameLayer(config: FramesConfig, state: Exclude<MockupState, 'plain'>): FrameLayer {
  const [kind, colour] = state.split('-') as ['framed' | 'mount', PrintFrameColour];
  const entry = config.frames[colour];
  const layer = kind === 'mount' ? entry?.mount : entry?.framed;
  if (!layer) throw new Error(`frames.json has no ${kind} master for colour "${colour}"`);
  const masterPath = path.isAbsolute(layer.file) ? layer.file : path.join(ROOT, layer.file);
  if (!fs.existsSync(masterPath)) {
    throw new Error(`Frame master not found: ${layer.file} (state ${state})`);
  }
  return { ...layer, file: masterPath };
}

async function main(): Promise<void> {
  const productId = getArg('product');
  const revisionArg = getArg('revision');
  const stateFilter = getArg('state');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  const design = registryPrintById(productId);
  if (!design) throw new Error(`Unknown print design "${productId}"`);

  const states = designMockupStates(design).filter(
    (s) => !stateFilter || s === stateFilter,
  ) as Exclude<MockupState, 'plain'>[];
  if (states.length === 0) {
    throw new Error(stateFilter ? `State "${stateFilter}" not offered by ${productId}` : `${productId} offers no framed states`);
  }

  const framesConfig = loadFramesConfig();
  for (const state of states) frameLayer(framesConfig, state); // fail fast before any I/O

  const bucket = printAssetsBucket();
  const stem = path.basename(design.image, path.extname(design.image)); // 'fap-01'
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-mockups-'));

  try {
    // Resolve each needed source profile once (framed and/or mount).
    const kinds = [...new Set(states.map((s) => s.split('-')[0] as 'framed' | 'mount'))];
    const sheets = new Map<'framed' | 'mount', Buffer>();
    for (const kind of kinds) {
      const asset = await resolveLatestReadyAsset(productId, SOURCE_PROFILE[kind], revisionArg);
      console.log(
        `source[${kind}]: profile=${asset.profile_key} revision=${asset.revision} ${asset.r2_key}`,
      );
      const { path: sourcePath } = await resolveSourcePath(productId, asset, scratchDir, bucket);
      sheets.set(kind, fs.readFileSync(sourcePath));
    }

    for (const state of states) {
      const kind = state.split('-')[0] as 'framed' | 'mount';
      const layer = frameLayer(framesConfig, state);
      const png = await composeMockup({
        master: fs.readFileSync(layer.file),
        sheet: sheets.get(kind)!,
        window: layer.window,
        outWidth: OUT_WIDTH,
        background: framesConfig.background,
      });
      const webps = await generateWebpSet(png, `${stem}-mock-${state}`, scratchDir);
      for (const file of webps) {
        file.r2Key = galleryR2Key(productId, `mock-${state}`, file.filename);
        const sizeKb = (fs.statSync(file.localPath).size / 1024).toFixed(0);
        if (dryRun) {
          console.log(`  would write R2 ${file.r2Key} (${sizeKb} KB) + mirror ${file.publicPath}`);
          continue;
        }
        const put = r2Put(bucket, file.r2Key, file.localPath, 'image/webp');
        if (!put.ok) throw new Error(`R2 upload failed for ${file.r2Key}: ${put.error}`);
        fs.copyFileSync(file.localPath, path.join(ROOT, 'public', file.publicPath));
        console.log(`  ${file.filename} → R2 + ${file.publicPath} (${sizeKb} KB)`);
      }
    }

    console.log(
      `\nDone. ${states.length} mockup state(s) for ${productId}.` +
        (dryRun ? ' [DRY RUN]' : ` Set \`mockups: true\` on ${productId} in src/lib/prints.ts and commit public/uploads/${stem}-mock-*.webp together.`),
    );
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
