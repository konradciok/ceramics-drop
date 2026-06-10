/**
 * import-new-plates.mjs  (one-off import helper)
 *
 * Converts public/uploads/small-plate-{1..16}.png to the canonical naming
 * scheme used by the product registry:
 *   small-plate-1.png  → talerz-maly-16.webp  (+400w/800w/1600w variants)
 *   small-plate-2.png  → talerz-maly-17.webp
 *   ...
 *   small-plate-16.png → talerz-maly-31.webp
 *
 * Then deletes the source PNGs — they don't belong in public/uploads/.
 *
 * Usage:
 *   node scripts/import-new-plates.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UPLOADS = path.join(ROOT, 'public', 'uploads');
const IMG_WIDTHS = [400, 800, 1600];

let totalBytes = 0;

for (let n = 1; n <= 16; n++) {
  const src = path.join(UPLOADS, `small-plate-${n}.png`);
  if (!fs.existsSync(src)) {
    console.error(`Missing source file: ${src}`);
    console.error('Copy the small-plate-N.png files into public/uploads/ before running this script.');
    process.exit(1);
  }

  const targetN = n + 15; // small-plate-1 → talerz-maly-16, ..., small-plate-16 → talerz-maly-31
  const baseName = `talerz-maly-${targetN}`;

  const baseOut = path.join(UPLOADS, `${baseName}.webp`);
  await sharp(src).webp({ quality: 80 }).toFile(baseOut);
  const { size: baseSize } = fs.statSync(baseOut);
  totalBytes += baseSize;
  console.log(`  small-plate-${n}.png → ${baseName}.webp  (${(baseSize / 1024).toFixed(0)} KB)`);

  for (const w of IMG_WIDTHS) {
    const varOut = path.join(UPLOADS, `${baseName}-${w}w.webp`);
    await sharp(src).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(varOut);
    const { size: vSize } = fs.statSync(varOut);
    totalBytes += vSize;
    console.log(`    → ${baseName}-${w}w.webp  (${(vSize / 1024).toFixed(0)} KB)`);
  }

  fs.unlinkSync(src);
}

console.log(`\nDone. Converted 16 plates (talerz-maly-16 … talerz-maly-31) + responsive variants.`);
console.log(`Total output: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
