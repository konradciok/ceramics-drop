import type { PrintDesign, PrintVariantSelection } from './types';
import { variantKey } from './print-cart';
import { catalogSource } from './catalog/source';

export const PRINT_DESIGNS: PrintDesign[] = [
  {
    id: 'fap01',
    category: 'fine-art-prints',
    num: '01',
    image: '/uploads/fap-01.webp',
    noteIndex: 0,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    // Live-mockup hero: fap-01-mock-*.webp composed from the published
    // 2026-07-12-r1 derivatives (print-assets:mockups) — ships with the flag.
    mockups: true,
  },
  {
    id: 'fap02',
    category: 'fine-art-prints',
    num: '02',
    image: '/uploads/fap-02.webp',
    gallery: ['/uploads/fap-02-room.webp'],
    noteIndex: 1,
    sizes: ['30x40', '50x70'],
    frameColours: ['black', 'natural'],
    mountAvailable: false,
    published: true,
  },
  {
    id: 'fap03',
    category: 'fine-art-prints',
    num: '03',
    image: '/uploads/fap-03.webp',
    noteIndex: 2,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
  },
  {
    // Unpublished test fixture — never renders, so its noteIndex is unused.
    id: 'fap04',
    category: 'fine-art-prints',
    num: '04',
    image: '/uploads/fap-04.webp',
    noteIndex: 0,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
];

const BY_ID = new Map(PRINT_DESIGNS.map((d) => [d.id, d]));

/* ------------------------------------------------------------------
   Sync registry helpers — read ONLY the code registry, never the DB.
   ------------------------------------------------------------------
   Mirror of products.ts: the public accessors below are async (CATALOG_SOURCE),
   but client cart surfaces and code-derived admin/fulfilment labels stay on the
   synchronous registry in Stage 3b. At parity these equal the async accessors
   in 'code' mode. */
export function registryPrintDesigns(): PrintDesign[] {
  return PRINT_DESIGNS.filter((d) => d.published);
}

export function registryPrintById(id: string): PrintDesign | undefined {
  return BY_ID.get(id);
}

/**
 * Async catalog core — 'code' returns the registry designs; 'db' reads the
 * catalog shadow tables (cached, Stage 3a) including drafts. Dynamic import of
 * the DB path keeps Cloudflare-only code out of the default 'code' flag and
 * breaks the load → repository → seed → prints import cycle.
 */
async function loadPrintCatalog(): Promise<{ designs: PrintDesign[]; byId: Map<string, PrintDesign> }> {
  if (catalogSource() === 'code') {
    return { designs: PRINT_DESIGNS, byId: BY_ID };
  }
  try {
    const { loadPrintDesignsFromDb } = await import('./catalog/load');
    const designs = await loadPrintDesignsFromDb();
    return { designs, byId: new Map(designs.map((d) => [d.id, d])) };
  } catch (err) {
    // Same resilience default as loadCeramicCatalog: fall back to the registry
    // on a DB read failure rather than breaking print PDPs + checkout.
    console.error('[catalog] print DB read failed; falling back to code registry', err);
    return { designs: PRINT_DESIGNS, byId: BY_ID };
  }
}

/** Published designs in registry order. */
export async function getPrintDesigns(): Promise<PrintDesign[]> {
  return (await loadPrintCatalog()).designs.filter((d) => d.published);
}

/** Resolve by id including unpublished — lets checkout reject hidden vs unknown. */
export async function getPrintById(id: string): Promise<PrintDesign | undefined> {
  return (await loadPrintCatalog()).byId.get(id);
}

/** Whether a variant is sellable for this design. */
export function isVariantAvailable(design: PrintDesign, sel: PrintVariantSelection): boolean {
  if (!design.published) return false;
  if (!design.sizes.includes(sel.size)) return false;
  if (sel.framed) {
    if (design.frameColours.length === 0) return false;
    if (sel.frameColour === 'none') return false;
    if (!design.frameColours.includes(sel.frameColour)) return false;
    if (sel.mount && !design.mountAvailable) return false;
  } else {
    if (sel.mount) return false; // passe-partout only exists inside a frame
    if (sel.frameColour !== 'none') return false;
  }
  if (design.unavailable?.includes(variantKey(sel))) return false;
  return true;
}
