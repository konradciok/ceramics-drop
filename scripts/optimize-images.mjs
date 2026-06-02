/**
 * optimize-images.mjs
 *
 * Converts the 88 product PNGs from design/uploads/ to optimized WebP files
 * in public/uploads/ at quality 80.
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

// Ensure output directory exists
fs.mkdirSync(OUT_DIR, { recursive: true });

const files = fs.readdirSync(SRC_DIR).filter((f) => PRODUCT_REGEX.test(f));
console.log(`Found ${files.length} product PNGs to convert.\n`);

let totalBytes = 0;

for (const file of files) {
  const input = path.join(SRC_DIR, file);
  const baseName = path.basename(file, '.png');
  const output = path.join(OUT_DIR, `${baseName}.webp`);

  await sharp(input).webp({ quality: 80 }).toFile(output);

  const { size } = fs.statSync(output);
  totalBytes += size;
  console.log(`  ${file} → ${baseName}.webp  (${(size / 1024).toFixed(0)} KB)`);
}

const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
console.log(`\nDone. Converted ${files.length} files → ${OUT_DIR}`);
console.log(`Total output size: ${totalMB} MB`);
