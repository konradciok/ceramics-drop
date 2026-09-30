/**
 * Suggest colour families for the /sklep colour filter and write them to
 * config/print-shop.json.
 *
 * Reads each design's 400 px storefront WebP from public/uploads/, drops the
 * white paper, classifies the remaining pixels into colour families
 * (src/lib/print-colour.ts) and stores the strongest 1–2 per design as
 * `{ colours, reviewed: false }`. The result is a SUGGESTION: review the
 * printed table, fix the JSON by hand where the eye disagrees and set
 * `reviewed: true` — reviewed entries are never overwritten without --force.
 *
 * Usage:
 *   npm run print-assets:facets -- --dry-run     # print the table, write nothing
 *   npm run print-assets:facets                  # write new/unreviewed entries
 *   npm run print-assets:facets -- --force       # also overwrite reviewed entries
 *
 * Run it after onboarding new designs (docs/print-asset-runbook.md): a CI test
 * fails while any published design has no colour entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { registryContentPrintDesigns } from '../src/lib/prints';
import { analyseColours } from '../src/lib/print-colour';
import { PRINT_SHOP_CONFIG, validatePrintShopConfig, type PrintShopConfig } from '../src/lib/print-shop-config';
import { SHOP_COLOURS } from '../src/lib/print-shop';
import { ROOT } from './lib/print-assets-cli';

const CONFIG_PATH = path.join(ROOT, 'config', 'print-shop.json');
const SAMPLE_SIZE = 64;

/** `/uploads/fap-001.webp` → `<root>/public/uploads/fap-001-400w.webp`. */
function thumbnailPath(image: string): string {
  const { dir, name, ext } = path.parse(image);
  return path.join(ROOT, 'public', dir, `${name}-400w${ext}`);
}

/** One line per design keeps the file diff-friendly. */
function serialise(cfg: PrintShopConfig): string {
  const rows = Object.keys(cfg.designs)
    .sort()
    .map((id) => `    ${JSON.stringify(id)}: ${JSON.stringify(cfg.designs[id]).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^{/, '{ ').replace(/}$/, ' }')}`);
  return [
    '{',
    `  "schemaVersion": ${cfg.schemaVersion},`,
    `  "featured": ${JSON.stringify(cfg.featured)},`,
    `  "newCount": ${cfg.newCount},`,
    '  "designs": {',
    rows.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');

  const designs = registryContentPrintDesigns();
  const next: PrintShopConfig = { ...PRINT_SHOP_CONFIG, designs: {} };

  console.log(['id'.padEnd(8), 'colours'.padEnd(16), ...SHOP_COLOURS.map((c) => c.padStart(6)), '  status'].join(' '));
  for (const d of designs) {
    const existing = PRINT_SHOP_CONFIG.designs[d.id];
    if (existing?.reviewed && !force) {
      next.designs[d.id] = existing;
      console.log([d.id.padEnd(8), existing.colours.join('+').padEnd(16), ...SHOP_COLOURS.map(() => '     ·'), '  kept (reviewed)'].join(' '));
      continue;
    }
    const file = thumbnailPath(d.image);
    if (!fs.existsSync(file)) throw new Error(`Missing thumbnail for ${d.id}: ${file}`);
    const { data } = await sharp(file)
      .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const analysis = analyseColours(data, 3);
    next.designs[d.id] = { colours: analysis.colours, reviewed: false };
    const shares = SHOP_COLOURS.map((c) => `${Math.round(analysis.shares[c] * 100)}%`.padStart(6));
    console.log([d.id.padEnd(8), analysis.colours.join('+').padEnd(16), ...shares, existing ? '  updated' : '  new'].join(' '));
  }

  // Throws on a malformed result before anything is written.
  validatePrintShopConfig(next, designs.map((d) => d.id));
  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  fs.writeFileSync(CONFIG_PATH, serialise(next));
  console.log(`\nWrote ${path.relative(ROOT, CONFIG_PATH)} (${Object.keys(next.designs).length} designs). Review it, then set "reviewed": true.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
