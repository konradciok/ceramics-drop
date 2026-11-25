/**
 * optimize-images.mjs
 *
 * Converts product PNGs from design/uploads/ to optimized WebP files
 * in public/uploads/ at quality 80.
 *
 * For each source file, emits:
 *   - <stem>.webp          (canonical base — used by product.image, JSON-LD, OG)
 *   - <stem>-400w.webp     (responsive variant)
 *   - <stem>-800w.webp     (responsive variant)
 *   - <stem>-1600w.webp    (responsive variant)
 *   - feed/<stem>.jpg      (1080×1080 JPEG for the Meta catalogue feed — Meta
 *                           rejects WebP; see src/lib/meta-catalog-feed.ts)
 *
 * Usage:
 *   node scripts/optimize-images.mjs
 *   node scripts/optimize-images.mjs --editorial
 *   node scripts/optimize-images.mjs --variants-only
 *   node scripts/optimize-images.mjs --src design/drop-2/_with_background/wazon-maly
 *   node scripts/optimize-images.mjs --feed-jpeg [--force]
 *
 * --feed-jpeg derives the Meta-feed JPEGs from the committed base WebPs in
 * public/uploads/ (no design sources needed). Existing JPEGs are kept unless
 * --force is passed, so a re-run only adds the missing ones.
 *
 * --src converts only the product files in that directory (PNG or JPEG) — use
 * it for a new drop so existing WebPs are not regenerated.
 *
 * Source files must match PRODUCT_PNG_REGEX below (<stem>-<n>.png|jpg|jpeg).
 *
 * Re-run any time to regenerate (safe to re-run; overwrites existing output).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const srcArgIndex = process.argv.indexOf('--src');
const SRC_DIR = srcArgIndex !== -1 && process.argv[srcArgIndex + 1]
  ? path.resolve(ROOT, process.argv[srcArgIndex + 1])
  : path.join(ROOT, 'design', 'uploads');
const OUT_DIR = path.join(ROOT, 'public', 'uploads');
/** Keep in sync with FEED_IMAGE_DIR in src/lib/meta-catalog-feed.ts. */
const FEED_OUT_DIR = path.join(OUT_DIR, 'feed');
const FEED_IMAGE_SIZE = 1080;

const PRODUCT_PNG_REGEX =
  /^(kubek|kubek-kolejny-nr|waza-mala|waza-duza|duza-waza|sredni-wazon|sredni-talerz|talerz-maly|talerz-duzy|duza-micha|duza-miska|miski-falowane|wazon-maly|wazon-sredni|wazon-duzy|kubek-drop2|miska-duza|miska-falowana|talerz-owalny|talerz-duzy-drop2|talerz-sredni|talerz-smallest|talerzyk)-\d+\.(png|jpe?g)$/i;

/** Canonical base WebPs only — excludes -400w/-800w/-1600w siblings. */
const PRODUCT_WEBP_REGEX =
  /^(kubek|kubek-kolejny-nr|waza-mala|waza-duza|duza-waza|sredni-wazon|sredni-talerz|talerz-maly|talerz-duzy|duza-micha|duza-miska|miski-falowane|wazon-maly|wazon-sredni|wazon-duzy|kubek-drop2|miska-duza|miska-falowana|talerz-owalny|talerz-duzy-drop2|talerz-sredni|talerz-smallest|talerzyk)-\d+\.webp$/;

/** Editorial JPEGs in public/uploads/ (e.g. 1ania.jpeg). */
const EDITORIAL_JPEG_REGEX = /^[123]ania\.jpe?g$/i;

// Keep in sync with IMG_WIDTHS in src/lib/images.ts (verified by images.test.ts)
const IMG_WIDTHS = [400, 800, 1600];

const variantsOnly = process.argv.includes('--variants-only');
const editorialOnly = process.argv.includes('--editorial');
const feedJpegOnly = process.argv.includes('--feed-jpeg');
const force = process.argv.includes('--force');

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

/**
 * Emit the square JPEG the Meta catalogue feed advertises. Meta accepts only
 * JPEG/PNG (no WebP), min 500×500, and crops feed/Advantage+ catalogue
 * placements to 1:1 — so the piece is letterboxed onto white rather than
 * cropped (the photos are square already; `contain` only guards a future
 * non-square source).
 */
async function emitFeedJpeg(input, baseName, logPrefix = '    ') {
  fs.mkdirSync(FEED_OUT_DIR, { recursive: true });
  const output = path.join(FEED_OUT_DIR, `${baseName}.jpg`);
  await sharp(input)
    .resize(FEED_IMAGE_SIZE, FEED_IMAGE_SIZE, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(output);
  const { size } = fs.statSync(output);
  console.log(`${logPrefix}→ feed/${baseName}.jpg  (${(size / 1024).toFixed(0)} KB)`);
  return size;
}

let totalBytes = 0;

if (feedJpegOnly) {
  const bases = fs.readdirSync(OUT_DIR).filter((f) => PRODUCT_WEBP_REGEX.test(f));
  if (bases.length === 0) {
    console.error(`No canonical base WebPs found in ${OUT_DIR}`);
    process.exit(1);
  }
  let written = 0;
  for (const file of bases) {
    const baseName = path.basename(file, '.webp');
    if (!force && fs.existsSync(path.join(FEED_OUT_DIR, `${baseName}.jpg`))) continue;
    totalBytes += await emitFeedJpeg(path.join(OUT_DIR, file), baseName, '  ');
    written += 1;
  }
  console.log(`\nDone. Wrote ${written} feed JPEGs (${bases.length - written} already present) → ${FEED_OUT_DIR}`);
  console.log(`Output size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
} else if (editorialOnly) {
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
  console.log(`Found ${files.length} product images to convert in ${SRC_DIR}.\n`);

  for (const file of files) {
    const input = path.join(SRC_DIR, file);
    const baseName = path.basename(file, path.extname(file));

    // Canonical base output (used by product.image, JSON-LD, OG)
    const output = path.join(OUT_DIR, `${baseName}.webp`);
    await sharp(input).webp({ quality: 80 }).toFile(output);
    const { size } = fs.statSync(output);
    totalBytes += size;
    console.log(`  ${file} → ${baseName}.webp  (${(size / 1024).toFixed(0)} KB)`);

    totalBytes += await emitResponsiveVariants(input, baseName);
    totalBytes += await emitFeedJpeg(input, baseName);
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  console.log(`\nDone. Converted ${files.length} files (+ ${files.length * IMG_WIDTHS.length} responsive variants) → ${OUT_DIR}`);
  console.log(`Total output size: ${totalMB} MB`);
}
