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
 *   node scripts/optimize-images.mjs --editorial
 *   node scripts/optimize-images.mjs --variants-only
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

const PRODUCT_PNG_REGEX =
  /^(kubek|waza-mala|waza-duza|sredni-talerz|talerz-maly|talerz-duzy|duza-micha|miski-falowane)-\d+\.png$/;

/** Canonical base WebPs only — excludes -400w/-800w/-1600w siblings. */
const PRODUCT_WEBP_REGEX =
  /^(kubek|waza-mala|waza-duza|sredni-talerz|talerz-maly|talerz-duzy|duza-micha|miski-falowane)-\d+\.webp$/;

/** Editorial JPEGs in public/uploads/ (e.g. 1ania.jpeg). */
const EDITORIAL_JPEG_REGEX = /^[123]ania\.jpe?g$/i;

// Keep in sync with IMG_WIDTHS in src/lib/images.ts (verified by images.test.ts)
const IMG_WIDTHS = [400, 800, 1600];

const variantsOnly = process.argv.includes('--variants-only');
const editorialOnly = process.argv.includes('--editorial');

// Ensure output directory exists
fs.mkdirSync(OUT_DIR, { recursive: true });

/** Emit -400w/-800w/-1600w siblings for a source image (PNG or base WebP). */
async function emitResponsiveVariants(input, baseName, logPrefix = '    ') {
  let variantBytes = 0;
  for (const w of IMG_WIDTHS) {
    const variantOutput = path.join(OUT_DIR, `${baseName}-${w}w.webp`);
    await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(variantOutput);
    const { size: vSize } = fs.statSync(variantOutput);
    variantBytes += vSize;
    console.log(`${logPrefix}→ ${baseName}-${w}w.webp  (${(vSize / 1024).toFixed(0)} KB)`);
  }
  return variantBytes;
}

let totalBytes = 0;

if (editorialOnly) {
  const files = fs.readdirSync(OUT_DIR).filter((f) => EDITORIAL_JPEG_REGEX.test(f));
  if (files.length === 0) {
    console.error(`No editorial JPEGs found in ${OUT_DIR} (expected 1ania.jpeg, 2ania.jpeg, 3ania.jpeg)`);
    process.exit(1);
  }
  console.log(`Found ${files.length} editorial JPEGs to convert.\n`);

  for (const file of files) {
    const input = path.join(OUT_DIR, file);
    const baseName = path.basename(file, path.extname(file));

    const output = path.join(OUT_DIR, `${baseName}.webp`);
    await sharp(input).webp({ quality: 80 }).toFile(output);
    const { size } = fs.statSync(output);
    totalBytes += size;
    console.log(`  ${file} → ${baseName}.webp  (${(size / 1024).toFixed(0)} KB)`);

    totalBytes += await emitResponsiveVariants(input, baseName);
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  console.log(`\nDone. Converted ${files.length} editorial files (+ ${files.length * IMG_WIDTHS.length} responsive variants) → ${OUT_DIR}`);
  console.log(`Total output size: ${totalMB} MB`);
} else if (variantsOnly) {
  const bases = fs.readdirSync(OUT_DIR).filter((f) => PRODUCT_WEBP_REGEX.test(f));
  if (bases.length === 0) {
    console.error(`No canonical base WebPs found in ${OUT_DIR}`);
    process.exit(1);
  }
  console.log(`Generating responsive variants for ${bases.length} base WebPs.\n`);

  for (const file of bases) {
    const input = path.join(OUT_DIR, file);
    const baseName = path.basename(file, '.webp');
    console.log(`  ${file}`);
    totalBytes += await emitResponsiveVariants(input, baseName, '    ');
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  console.log(`\nDone. Generated ${bases.length * IMG_WIDTHS.length} responsive variants → ${OUT_DIR}`);
  console.log(`Variant output size: ${totalMB} MB`);
} else {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Source directory not found: ${SRC_DIR}`);
    console.error('The product PNGs live in design/uploads/ (gitignored). Restore them before running this script,');
    console.error('or run with --variants-only to generate responsive siblings from public/uploads/*.webp.');
    process.exit(1);
  }

  const files = fs.readdirSync(SRC_DIR).filter((f) => PRODUCT_PNG_REGEX.test(f));
  console.log(`Found ${files.length} product PNGs to convert.\n`);

  for (const file of files) {
    const input = path.join(SRC_DIR, file);
    const baseName = path.basename(file, '.png');

    // Canonical base output (used by product.image, JSON-LD, OG)
    const output = path.join(OUT_DIR, `${baseName}.webp`);
    await sharp(input).webp({ quality: 80 }).toFile(output);
    const { size } = fs.statSync(output);
    totalBytes += size;
    console.log(`  ${file} → ${baseName}.webp  (${(size / 1024).toFixed(0)} KB)`);

    totalBytes += await emitResponsiveVariants(input, baseName);
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  console.log(`\nDone. Converted ${files.length} files (+ ${files.length * IMG_WIDTHS.length} responsive variants) → ${OUT_DIR}`);
  console.log(`Total output size: ${totalMB} MB`);
}
