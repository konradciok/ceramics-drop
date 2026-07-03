/* ============================================================
   Product-asset hygiene — registry ↔ public/uploads parity
   ------------------------------------------------------------
   Two guardrails that lock in the dead-asset cleanup so orphan
   images cannot silently drift back in (e.g. via a stray
   `npm run optimize-images` run regenerating a removed stem):

     1. Every image / gallery path the registry references must
        exist on disk — canonical WebP + all responsive variants.
     2. Every canonical WebP in public/uploads must be referenced
        by the registry, or be on the explicit ALLOWLIST below.

   The base image stem of a piece is non-trivially derived in
   products.ts (non-contiguous `files` arrays, gallery merges),
   so this test reads the *resolved* paths from getProducts()
   rather than re-deriving them.
   ============================================================ */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getProducts } from './products';
import { PRINT_DESIGNS } from './prints';
import { IMG_WIDTHS } from './images';
import { DIRECT_EDITORIAL_IMAGES } from './editorial-images';

const UPLOADS_DIR = path.join(process.cwd(), 'public', 'uploads');

/** Canonical WebP bases that legitimately have no registry reference.
 *  Keep this list tiny and justify every entry — an unexplained entry
 *  defeats the guardrail. */
const ALLOWLIST = new Set([
  // duże misy b05/b06 — withdrawn from the catalogue in the June
  // inventory review but images retained pending a possible
  // gallery-merge re-add (see products.ts REMOVED + project notes).
  'duza-micha-5',
  'duza-micha-6',
]);

/** Strip a responsive suffix (`-400w` / `-800w` / `-1600w`) and the
 *  `.webp` extension to get a file's canonical base stem. */
function baseStem(file: string): string {
  return file.replace(/\.webp$/, '').replace(/-\d+w$/, '');
}

/** Registry image/gallery paths, as `/uploads/...webp` strings. */
function registryImagePaths(): string[] {
  const paths: string[] = [];
  for (const p of [...getProducts(), ...PRINT_DESIGNS]) {
    paths.push(p.image);
    for (const g of p.gallery ?? []) paths.push(g);
  }
  return paths;
}

/** Direct editorial assets rendered by home, studio, and gallery pages. */
function editorialImagePaths(): string[] {
  return DIRECT_EDITORIAL_IMAGES.map((image) => image.src);
}

describe('product asset hygiene', () => {
  it('every registry/editorial image (+ responsive variants) exists on disk', () => {
    const missing: string[] = [];
    for (const rel of [...registryImagePaths(), ...editorialImagePaths()]) {
      const full = path.join(process.cwd(), 'public', rel);
      if (!existsSync(full)) missing.push(rel);
      // Each listed image is served through srcSet() — the variants must exist.
      const dot = full.lastIndexOf('.');
      for (const w of IMG_WIDTHS) {
        const variant = `${full.slice(0, dot)}-${w}w${full.slice(dot)}`;
        if (!existsSync(variant)) missing.push(`${rel} [${w}w]`);
      }
    }
    expect(missing, `missing image files:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no orphan WebPs in public/uploads (every base is referenced or allowlisted)', () => {
    const referenced = new Set(
      [...registryImagePaths(), ...editorialImagePaths()].map((p) => baseStem(path.basename(p))),
    );
    const orphans = [
      ...new Set(
        readdirSync(UPLOADS_DIR)
          .filter((f) => f.endsWith('.webp'))
          .map(baseStem),
      ),
    ]
      .filter((base) => !referenced.has(base) && !ALLOWLIST.has(base))
      .sort();
    expect(
      orphans,
      `unreferenced WebP bases (delete them, reference them, or allowlist with a reason):\n${orphans.join('\n')}`,
    ).toEqual([]);
  });
});
