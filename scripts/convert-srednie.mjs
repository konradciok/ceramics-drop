import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPLOADS = path.join(ROOT, 'public', 'uploads');
const IMG_WIDTHS = [400, 800, 1600];

for (const n of [17, 18]) {
  const src = path.join(UPLOADS, `sredni-talerz-${n}.png`);
  const base = `sredni-talerz-${n}`;
  await sharp(src).webp({ quality: 80 }).toFile(path.join(UPLOADS, `${base}.webp`));
  for (const w of IMG_WIDTHS) {
    await sharp(src).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(UPLOADS, `${base}-${w}w.webp`));
  }
  fs.unlinkSync(src);
  console.log(`Converted ${base}`);
}
