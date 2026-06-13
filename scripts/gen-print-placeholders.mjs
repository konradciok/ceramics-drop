/**
 * gen-print-placeholders.mjs
 *
 * TEMPORARY dev-ops helper. The fine-art-print registry (src/lib/prints.ts)
 * references /uploads/fap-*.webp images that don't exist yet — the studio's real
 * artwork lands in a few days. Until then every print tile / PDP renders a broken
 * image, which blocks local dev + preview verification.
 *
 * This emits clearly-labelled placeholder WebPs (base + the three responsive
 * widths srcSet() expects) so the prints surfaces render during development.
 *
 * Usage:  node scripts/gen-print-placeholders.mjs
 *
 * When real art arrives: extend the stem regex in scripts/optimize-images.mjs to
 * cover the studio's print naming (incl. gallery suffixes like -room/-detail),
 * drop the PNGs into design/uploads/, run `npm run optimize-images`, then delete
 * this script + these files. The placeholders are intentionally ugly so nobody
 * ships them by accident.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'uploads');

// Responsive widths must match IMG_WIDTHS in src/lib/images.ts.
const WIDTHS = [400, 800, 1600];
// Product grid is a uniform 4:5 portrait (see product-photo-proportions memory).
const RATIO = 5 / 4;

// Image bases referenced by PRINT_DESIGNS (design.image + every gallery entry).
const BASES = [
  'fap-01', 'fap-01-room', 'fap-01-detail',
  'fap-02', 'fap-02-room',
  'fap-03',
];

const BG = '#e7e2d8';   // muted clay/paper tone, on-brand-ish but obviously flat
const FG = '#9a8f7d';

function svg(label, w) {
  const h = Math.round(w * RATIO);
  const fontSize = Math.round(w / 9);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="100%" height="100%" fill="${BG}"/>
      <rect x="${w * 0.04}" y="${w * 0.04}" width="${w * 0.92}" height="${h - w * 0.08}"
            fill="none" stroke="${FG}" stroke-width="${Math.max(2, w / 200)}" stroke-dasharray="${w / 30} ${w / 45}"/>
      <text x="50%" y="48%" font-family="sans-serif" font-size="${fontSize}" font-weight="700"
            fill="${FG}" text-anchor="middle">${label}</text>
      <text x="50%" y="48%" dy="${fontSize}" font-family="sans-serif" font-size="${Math.round(fontSize * 0.5)}"
            fill="${FG}" text-anchor="middle">placeholder</text>
    </svg>`,
  );
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let count = 0;
for (const base of BASES) {
  const label = base.toUpperCase();
  // base (no width suffix) = the <img src> fallback, rendered at the 800w size.
  const targets = [['', 800], ...WIDTHS.map((w) => [`-${w}w`, w])];
  for (const [suffix, w] of targets) {
    const out = path.join(OUT_DIR, `${base}${suffix}.webp`);
    await sharp(svg(label, w))
      .resize(w, Math.round(w * RATIO))
      .webp({ quality: 70 })
      .toFile(out);
    count += 1;
  }
}

console.log(`Wrote ${count} placeholder WebP(s) for ${BASES.length} print image base(s) → public/uploads/`);
