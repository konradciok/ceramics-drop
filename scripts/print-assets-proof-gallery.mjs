/**
 * print-assets-proof-gallery.mjs
 *
 * Storefront gallery/hero image for fine-art prints, sourced from the
 * `_1920_proof.jpg` file the studio delivers alongside each fulfilment
 * master — NOT from a published R2 fulfilment derivative. Deliberately
 * separate from `scripts/print-assets-gallery.ts`, whose
 * `resolveGallerySource()` is a hash-verified integrity chain against the
 * *fulfilment* asset a customer's print is actually made from; the proof
 * file is a normalized preview image (fixed 1440x1920px regardless of the
 * painting), unrelated to that chain, and only ever feeds the storefront
 * tile/PDP hero — Prodigi never sees it.
 *
 * For each `design/uploads/master-images-prints/print-0NN/print-0NN_1920_proof.jpg`,
 * emits into public/uploads/:
 *   - fap-0NN.webp          (canonical — product.image, JSON-LD, OG)
 *   - fap-0NN-400w.webp     (responsive variant)
 *   - fap-0NN-800w.webp     (responsive variant)
 *   - fap-0NN-1600w.webp    (responsive variant)
 *
 * Usage:
 *   node scripts/print-assets-proof-gallery.mjs               # every print-0NN folder found
 *   node scripts/print-assets-proof-gallery.mjs --product fap001
 *
 * Safe to re-run — overwrites existing output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC_DIR = path.join(ROOT, 'design', 'uploads', 'master-images-prints');
const OUT_DIR = path.join(ROOT, 'public', 'uploads');

// Keep in sync with IMG_WIDTHS in src/lib/images.ts (verified by images.test.ts)
const IMG_WIDTHS = [400, 800, 1600];

const FOLDER_REGEX = /^print-(\d{3})$/;

function parseProductFilter() {
  const idx = process.argv.indexOf('--product');
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value) {
    console.error('--product requires a value, e.g. --product fap001');
    process.exit(1);
  }
  const match = /^fap(\d{3})$/.exec(value);
  if (!match) {
    console.error(`--product must look like "fap0NN", got "${value}"`);
    process.exit(1);
  }
  return match[1];
}

async function emitResponsiveVariants(input, baseName) {
  let variantBytes = 0;
  for (const w of IMG_WIDTHS) {
    const variantOutput = path.join(OUT_DIR, `${baseName}-${w}w.webp`);
    await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(variantOutput);
    const { size } = fs.statSync(variantOutput);
    variantBytes += size;
    console.log(`    → ${baseName}-${w}w.webp  (${(size / 1024).toFixed(0)} KB)`);
  }
  return variantBytes;
}

if (!fs.existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  process.exit(1);
}

const onlyNNN = parseProductFilter();

const folders = fs
  .readdirSync(SRC_DIR)
  .filter((f) => FOLDER_REGEX.test(f))
  .map((f) => FOLDER_REGEX.exec(f)[1])
  .filter((nnn) => !onlyNNN || nnn === onlyNNN)
  .sort();

if (folders.length === 0) {
  console.error(onlyNNN ? `No print-${onlyNNN} folder found under ${SRC_DIR}` : `No print-0NN folders found under ${SRC_DIR}`);
  process.exit(1);
}

console.log(`Found ${folders.length} design(s) to process.\n`);

fs.mkdirSync(OUT_DIR, { recursive: true });

let totalBytes = 0;
let missing = 0;

for (const nnn of folders) {
  const folder = `print-${nnn}`;
  const proofPath = path.join(SRC_DIR, folder, `${folder}_1920_proof.jpg`);
  const baseName = `fap-${nnn}`;

  if (!fs.existsSync(proofPath)) {
    console.error(`  ${folder}: missing ${folder}_1920_proof.jpg — skipped`);
    missing += 1;
    continue;
  }

  const output = path.join(OUT_DIR, `${baseName}.webp`);
  await sharp(proofPath).webp({ quality: 80 }).toFile(output);
  const { size } = fs.statSync(output);
  totalBytes += size;
  console.log(`  ${folder} → ${baseName}.webp  (${(size / 1024).toFixed(0)} KB)`);

  totalBytes += await emitResponsiveVariants(proofPath, baseName);
}

const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
const done = folders.length - missing;
console.log(`\nDone. Converted ${done} design(s) (+ ${done * IMG_WIDTHS.length} responsive variants) → ${OUT_DIR}`);
console.log(`Total output size: ${totalMB} MB`);
if (missing > 0) {
  console.error(`${missing} design(s) skipped (missing proof file).`);
  process.exit(1);
}
