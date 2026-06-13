/* ============================================================
   Fine-art print registry — code-driven catalogue of print designs.
   ------------------------------------------------------------
   Deliberately SEPARATE from src/lib/products.ts: prints are reproducible
   (open edition), variant-configurable, and never enter `piece_state` or
   `reserve_pieces`. Keeping them out of the ceramic registry contains the
   blast radius of the new commerce shape.

   MVP is code-driven (like ceramics): designs here, copy in messages/*.json,
   images via `npm run optimize-images`. An admin panel is a later phase.

   ⚠️ The designs below are PLACEHOLDERS (ids, images, axes) until the studio
   supplies real artwork, sizes, papers, frames and prices.
   ============================================================ */
import type { PrintDesign, PrintVariantSelection } from './types';
import { variantKey } from './print-cart';

export const PRINT_DESIGNS: PrintDesign[] = [
  {
    id: 'fap01',
    category: 'fine-art-prints',
    num: '01',
    image: '/uploads/fap-01.webp',
    gallery: ['/uploads/fap-01-room.webp', '/uploads/fap-01-detail.webp'],
    noteIndex: 0,
    sizes: ['a4', 'a3', 'a2'],
    papers: ['matte', 'satin'],
    frames: ['none', 'oak', 'black'],
    published: true,
    fromPLN: 120,
  },
  {
    id: 'fap02',
    category: 'fine-art-prints',
    num: '02',
    image: '/uploads/fap-02.webp',
    gallery: ['/uploads/fap-02-room.webp'],
    noteIndex: 1,
    sizes: ['a4', 'a3'],
    papers: ['matte', 'satin'],
    frames: ['none', 'black'],
    // The black frame is not offered on the satin A3 of this design.
    unavailable: ['a3:satin:black'],
    published: true,
    fromPLN: 120,
  },
  {
    // Unpublished example: resolvable by id (so checkout can reject it) but
    // never listed or sellable.
    id: 'fap03',
    category: 'fine-art-prints',
    num: '03',
    image: '/uploads/fap-03.webp',
    noteIndex: 2,
    sizes: ['a4', 'a3', 'a2'],
    papers: ['matte', 'satin'],
    frames: ['none', 'oak', 'black'],
    published: false,
    fromPLN: 120,
  },
];

const BY_ID = new Map(PRINT_DESIGNS.map((d) => [d.id, d]));

/** All published designs, in registry order (listing / sitemap / SEO). */
export function getPrintDesigns(): PrintDesign[] {
  return PRINT_DESIGNS.filter((d) => d.published);
}

/**
 * Resolve a design by id, INCLUDING unpublished ones — callers that gate on
 * `published` (checkout, PDP) need to tell "unknown" apart from "hidden".
 */
export function getPrintById(id: string): PrintDesign | undefined {
  return BY_ID.get(id);
}

/** Deterministic SKU for invoices / shipping labels, e.g. `FAP-01-A3-SATIN-OAK`. */
export function skuOf(design: PrintDesign, sel: PrintVariantSelection): string {
  return `FAP-${design.num}-${sel.size}-${sel.paper}-${sel.frame}`.toUpperCase();
}

/**
 * Whether a variant is actually sellable: the design is published, every axis
 * value is offered by the design, and the combination is not explicitly excluded.
 */
export function isVariantAvailable(design: PrintDesign, sel: PrintVariantSelection): boolean {
  if (!design.published) return false;
  if (!design.sizes.includes(sel.size)) return false;
  if (!design.papers.includes(sel.paper)) return false;
  if (!design.frames.includes(sel.frame)) return false;
  if (design.unavailable?.includes(variantKey(sel))) return false;
  return true;
}
