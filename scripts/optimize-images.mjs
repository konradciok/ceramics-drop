/**
 * optimize-images.mjs
 *
 * Converts the 88 product PNGs from design/uploads/ to optimized WebP files
 * in public/uploads/ at quality 80.
 *
 * For each source file, emits:
 *   - <stem>.webp          (canonical base — used by product.image, JSON-LD, OG)
 *   - <stem>-400w.webp     (responsive variant)
 *   - <stem>-800w.webp     (responsive variant)
 *   - <stem>-1600w.webp    (responsive variant)
 *
 * Usage:
 *   node scripts/optimize-images.mjs
 *
 * Source files must match the product regex:
 *   ^(kubek|waza-mala|waza-duza|talerz-maly|talerz-duzy|duza-micha|miski-falowane)-\d+\.png$
 *
 * Re-run any time to regenerate (safe to re-run; overwrites existing output).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC_DIR = path.join(ROOT, 'design', 'uploads');
const OUT_DIR = path.join(ROOT, 'public', 'uploads');

const PRODUCT_REGEX =
  /^(kubek|waza-mala|waza-duza|talerz-maly|talerz-duzy|duza-micha|miski-falowane)-\d+\.png$/;

const IMG_WIDTHS = [400, 800, 1600];

// Ensure output directory exists
fs.mkdirSync(OUT_DIR, { recursive: true });

if (!fs.existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  console.error('The product PNGs live in design/uploads/ (gitignored). Restore them before running this script.');
  process.exit(1);
}

const files = fs.readdirSync(SRC_DIR).filter((f) => PRODUCT_REGEX.test(f));
console.log(`Found ${files.length} product PNGs to convert.\n`);

let totalBytes = 0;

for (const file of files) {
  const input = path.join(SRC_DIR, file);
  const baseName = path.basename(file, '.png');

  // Canonical base output (used by product.image, JSON-LD, OG)
  const output = path.join(OUT_DIR, `${baseName}.webp`);
  await sharp(input).webp({ quality: 80 }).toFile(output);
  const { size } = fs.statSync(output);
  totalBytes += size;
  console.log(`  ${file} → ${baseName}.webp  (${(size / 1024).toFixed(0)} KB)`);

  // Responsive variants
  for (const w of IMG_WIDTHS) {
    const variantOutput = path.join(OUT_DIR, `${baseName}-${w}w.webp`);
    await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(variantOutput);
    const { size: vSize } = fs.statSync(variantOutput);
    totalBytes += vSize;
    console.log(`    → ${baseName}-${w}w.webp  (${(vSize / 1024).toFixed(0)} KB)`);
  }
}

const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
console.log(`\nDone. Converted ${files.length} files (+ ${files.length * IMG_WIDTHS.length} responsive variants) → ${OUT_DIR}`);
console.log(`Total output size: ${totalMB} MB`);
