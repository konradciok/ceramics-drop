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
    // 2026-08-03: widened to full axes (policy: every print offers every
    // variant). Master (8000x11313) covers the 8400x12000 and 2x3 profiles
    // without upscaling — the earlier 30x40/50x70-only shape was a
    // merchandising restriction, not a technical one. New profiles need a
    // print-assets prepare + publish run for fap02 before the new variants
    // are purchasable (checkout fails closed with print_asset_unavailable).
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
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
  // Full-bleed paintings 01-05 (docs/plans/full-bleed-print-assets-plan.md),
  // onboarded via print-assets:onboard from design/uploads/master-images-prints/.
  // Titles/noteIndex text are placeholders — real note copy still needed in
  // messages/{pl,en,es,de}.json before publishing. published:false until the
  // prepare -> upload -> verify -> publish -> gallery pipeline runs per design.
  {
    id: 'fap005',
    category: 'fine-art-prints',
    num: '005',
    image: '/uploads/fap-005.webp',
    noteIndex: 3,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap006',
    category: 'fine-art-prints',
    num: '006',
    image: '/uploads/fap-006.webp',
    noteIndex: 4,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap007',
    category: 'fine-art-prints',
    num: '007',
    image: '/uploads/fap-007.webp',
    noteIndex: 5,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap008',
    category: 'fine-art-prints',
    num: '008',
    image: '/uploads/fap-008.webp',
    noteIndex: 6,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap009',
    category: 'fine-art-prints',
    num: '009',
    image: '/uploads/fap-009.webp',
    noteIndex: 7,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  // Full-bleed paintings 06-43 (docs/plans/full-bleed-print-assets-plan.md),
  // onboarded via print-assets:onboard from design/uploads/master-images-prints/.
  // Same caveats as the 01-05 batch above: placeholder titles, note copy still
  // needed, published:false until the per-design pipeline runs.
  {
    id: 'fap010',
    category: 'fine-art-prints',
    num: '010',
    image: '/uploads/fap-010.webp',
    noteIndex: 8,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap011',
    category: 'fine-art-prints',
    num: '011',
    image: '/uploads/fap-011.webp',
    noteIndex: 9,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap012',
    category: 'fine-art-prints',
    num: '012',
    image: '/uploads/fap-012.webp',
    noteIndex: 10,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap013',
    category: 'fine-art-prints',
    num: '013',
    image: '/uploads/fap-013.webp',
    noteIndex: 11,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap014',
    category: 'fine-art-prints',
    num: '014',
    image: '/uploads/fap-014.webp',
    noteIndex: 12,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap015',
    category: 'fine-art-prints',
    num: '015',
    image: '/uploads/fap-015.webp',
    noteIndex: 13,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap016',
    category: 'fine-art-prints',
    num: '016',
    image: '/uploads/fap-016.webp',
    noteIndex: 14,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap017',
    category: 'fine-art-prints',
    num: '017',
    image: '/uploads/fap-017.webp',
    noteIndex: 15,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap018',
    category: 'fine-art-prints',
    num: '018',
    image: '/uploads/fap-018.webp',
    noteIndex: 16,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap019',
    category: 'fine-art-prints',
    num: '019',
    image: '/uploads/fap-019.webp',
    noteIndex: 17,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap020',
    category: 'fine-art-prints',
    num: '020',
    image: '/uploads/fap-020.webp',
    noteIndex: 18,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap021',
    category: 'fine-art-prints',
    num: '021',
    image: '/uploads/fap-021.webp',
    noteIndex: 19,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap022',
    category: 'fine-art-prints',
    num: '022',
    image: '/uploads/fap-022.webp',
    noteIndex: 20,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap023',
    category: 'fine-art-prints',
    num: '023',
    image: '/uploads/fap-023.webp',
    noteIndex: 21,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap024',
    category: 'fine-art-prints',
    num: '024',
    image: '/uploads/fap-024.webp',
    noteIndex: 22,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap025',
    category: 'fine-art-prints',
    num: '025',
    image: '/uploads/fap-025.webp',
    noteIndex: 23,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap026',
    category: 'fine-art-prints',
    num: '026',
    image: '/uploads/fap-026.webp',
    noteIndex: 24,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap027',
    category: 'fine-art-prints',
    num: '027',
    image: '/uploads/fap-027.webp',
    noteIndex: 25,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap028',
    category: 'fine-art-prints',
    num: '028',
    image: '/uploads/fap-028.webp',
    noteIndex: 26,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap029',
    category: 'fine-art-prints',
    num: '029',
    image: '/uploads/fap-029.webp',
    noteIndex: 27,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap030',
    category: 'fine-art-prints',
    num: '030',
    image: '/uploads/fap-030.webp',
    noteIndex: 28,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap031',
    category: 'fine-art-prints',
    num: '031',
    image: '/uploads/fap-031.webp',
    noteIndex: 29,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap032',
    category: 'fine-art-prints',
    num: '032',
    image: '/uploads/fap-032.webp',
    noteIndex: 30,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap033',
    category: 'fine-art-prints',
    num: '033',
    image: '/uploads/fap-033.webp',
    noteIndex: 31,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap034',
    category: 'fine-art-prints',
    num: '034',
    image: '/uploads/fap-034.webp',
    noteIndex: 32,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap035',
    category: 'fine-art-prints',
    num: '035',
    image: '/uploads/fap-035.webp',
    noteIndex: 33,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap036',
    category: 'fine-art-prints',
    num: '036',
    image: '/uploads/fap-036.webp',
    noteIndex: 34,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap037',
    category: 'fine-art-prints',
    num: '037',
    image: '/uploads/fap-037.webp',
    noteIndex: 35,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap038',
    category: 'fine-art-prints',
    num: '038',
    image: '/uploads/fap-038.webp',
    noteIndex: 36,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap039',
    category: 'fine-art-prints',
    num: '039',
    image: '/uploads/fap-039.webp',
    noteIndex: 37,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap040',
    category: 'fine-art-prints',
    num: '040',
    image: '/uploads/fap-040.webp',
    noteIndex: 38,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap041',
    category: 'fine-art-prints',
    num: '041',
    image: '/uploads/fap-041.webp',
    noteIndex: 39,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap042',
    category: 'fine-art-prints',
    num: '042',
    image: '/uploads/fap-042.webp',
    noteIndex: 40,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap043',
    category: 'fine-art-prints',
    num: '043',
    image: '/uploads/fap-043.webp',
    noteIndex: 41,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap044',
    category: 'fine-art-prints',
    num: '044',
    image: '/uploads/fap-044.webp',
    noteIndex: 42,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap045',
    category: 'fine-art-prints',
    num: '045',
    image: '/uploads/fap-045.webp',
    noteIndex: 43,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap046',
    category: 'fine-art-prints',
    num: '046',
    image: '/uploads/fap-046.webp',
    noteIndex: 44,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
  },
  {
    id: 'fap047',
    category: 'fine-art-prints',
    num: '047',
    image: '/uploads/fap-047.webp',
    noteIndex: 45,
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
