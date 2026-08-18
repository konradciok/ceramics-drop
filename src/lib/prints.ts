import type { PrintDesign, PrintVariantSelection } from './types';
import { variantKey } from './print-cart';
import { catalogSource } from './catalog/source';
import { MOUNT_TEMPORARILY_DISABLED } from './print-availability';

// Fine-art-print registry reset 2026-08-17: the prior fap01–fap04 / fap005–
// fap047 registry (47 ids) is fully retired — old sources were corrupted,
// R2 + the DB catalog rows were wiped (verified no real customer order
// referenced any of those ids beyond two refunded 2026-08-13 rehearsal test
// orders). This is a fresh batch of 41 paintings (`print-001`..`print-041`,
// 2 duplicates already removed upstream), renumbered fap001..fap041 1:1 with
// the source folder number. `mountAvailable: false` is the actual stored
// truth for every design here (not just read-gated, see
// print-availability.ts) — no mount-crop source exists in this batch at all.
// `fap001`/`fap002`/`fap003`/`fap025`/`fap032`/`fap033` were all held back
// for the same reason (undersized + off-ratio `_70x100`) but got corrected
// re-exports 2026-08-17 (all now ≥8400x12000 at ~7:10) — published:true.
// `noteIndex` is 0-based, matching array position directly (no
// notes["fine-art-prints"] entries exist yet — placeholder copy pending the
// Notion i18n content pass, see docs/notion-i18n.md).
const RAW_PRINT_DESIGNS: PrintDesign[] = [
  {
    id: 'fap001',
    category: 'fine-art-prints',
    num: '1',
    image: '/uploads/fap-001.webp',
    noteIndex: 0,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap002',
    category: 'fine-art-prints',
    num: '2',
    image: '/uploads/fap-002.webp',
    noteIndex: 1,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap003',
    category: 'fine-art-prints',
    num: '3',
    image: '/uploads/fap-003.webp',
    noteIndex: 2,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap004',
    category: 'fine-art-prints',
    num: '4',
    image: '/uploads/fap-004.webp',
    noteIndex: 3,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap005',
    category: 'fine-art-prints',
    num: '5',
    image: '/uploads/fap-005.webp',
    noteIndex: 4,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap006',
    category: 'fine-art-prints',
    num: '6',
    image: '/uploads/fap-006.webp',
    noteIndex: 5,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap007',
    category: 'fine-art-prints',
    num: '7',
    image: '/uploads/fap-007.webp',
    noteIndex: 6,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap008',
    category: 'fine-art-prints',
    num: '8',
    image: '/uploads/fap-008.webp',
    noteIndex: 7,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap009',
    category: 'fine-art-prints',
    num: '9',
    image: '/uploads/fap-009.webp',
    noteIndex: 8,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap010',
    category: 'fine-art-prints',
    num: '10',
    image: '/uploads/fap-010.webp',
    noteIndex: 9,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap011',
    category: 'fine-art-prints',
    num: '11',
    image: '/uploads/fap-011.webp',
    noteIndex: 10,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap012',
    category: 'fine-art-prints',
    num: '12',
    image: '/uploads/fap-012.webp',
    noteIndex: 11,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap013',
    category: 'fine-art-prints',
    num: '13',
    image: '/uploads/fap-013.webp',
    noteIndex: 12,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap014',
    category: 'fine-art-prints',
    num: '14',
    image: '/uploads/fap-014.webp',
    noteIndex: 13,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap015',
    category: 'fine-art-prints',
    num: '15',
    image: '/uploads/fap-015.webp',
    noteIndex: 14,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap016',
    category: 'fine-art-prints',
    num: '16',
    image: '/uploads/fap-016.webp',
    noteIndex: 15,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap017',
    category: 'fine-art-prints',
    num: '17',
    image: '/uploads/fap-017.webp',
    noteIndex: 16,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap018',
    category: 'fine-art-prints',
    num: '18',
    image: '/uploads/fap-018.webp',
    noteIndex: 17,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap019',
    category: 'fine-art-prints',
    num: '19',
    image: '/uploads/fap-019.webp',
    noteIndex: 18,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap020',
    category: 'fine-art-prints',
    num: '20',
    image: '/uploads/fap-020.webp',
    noteIndex: 19,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap021',
    category: 'fine-art-prints',
    num: '21',
    image: '/uploads/fap-021.webp',
    noteIndex: 20,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap022',
    category: 'fine-art-prints',
    num: '22',
    image: '/uploads/fap-022.webp',
    noteIndex: 21,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap023',
    category: 'fine-art-prints',
    num: '23',
    image: '/uploads/fap-023.webp',
    noteIndex: 22,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap024',
    category: 'fine-art-prints',
    num: '24',
    image: '/uploads/fap-024.webp',
    noteIndex: 23,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap025',
    category: 'fine-art-prints',
    num: '25',
    image: '/uploads/fap-025.webp',
    noteIndex: 24,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap026',
    category: 'fine-art-prints',
    num: '26',
    image: '/uploads/fap-026.webp',
    noteIndex: 25,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap027',
    category: 'fine-art-prints',
    num: '27',
    image: '/uploads/fap-027.webp',
    noteIndex: 26,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap028',
    category: 'fine-art-prints',
    num: '28',
    image: '/uploads/fap-028.webp',
    noteIndex: 27,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap029',
    category: 'fine-art-prints',
    num: '29',
    image: '/uploads/fap-029.webp',
    noteIndex: 28,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap030',
    category: 'fine-art-prints',
    num: '30',
    image: '/uploads/fap-030.webp',
    noteIndex: 29,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap031',
    category: 'fine-art-prints',
    num: '31',
    image: '/uploads/fap-031.webp',
    noteIndex: 30,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap032',
    category: 'fine-art-prints',
    num: '32',
    image: '/uploads/fap-032.webp',
    noteIndex: 31,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap033',
    category: 'fine-art-prints',
    num: '33',
    image: '/uploads/fap-033.webp',
    noteIndex: 32,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap034',
    category: 'fine-art-prints',
    num: '34',
    image: '/uploads/fap-034.webp',
    noteIndex: 33,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap035',
    category: 'fine-art-prints',
    num: '35',
    image: '/uploads/fap-035.webp',
    noteIndex: 34,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap036',
    category: 'fine-art-prints',
    num: '36',
    image: '/uploads/fap-036.webp',
    noteIndex: 35,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap037',
    category: 'fine-art-prints',
    num: '37',
    image: '/uploads/fap-037.webp',
    noteIndex: 36,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap038',
    category: 'fine-art-prints',
    num: '38',
    image: '/uploads/fap-038.webp',
    noteIndex: 37,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap039',
    category: 'fine-art-prints',
    num: '39',
    image: '/uploads/fap-039.webp',
    noteIndex: 38,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap040',
    category: 'fine-art-prints',
    num: '40',
    image: '/uploads/fap-040.webp',
    noteIndex: 39,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
  {
    id: 'fap041',
    category: 'fine-art-prints',
    num: '41',
    image: '/uploads/fap-041.webp',
    noteIndex: 40,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    published: true,
    mockups: true,
  },
];

/**
 * Ungated designs — authored truth, mount included. Seed-only: the catalog
 * backfill (`src/lib/catalog/seed.ts`) must keep emitting every structurally
 * valid variant row so a run during the mount-disabled window reproduces the
 * existing DB exactly. Storefront/checkout readers use `PRINT_DESIGNS`.
 */
export const PRINT_DESIGNS_RAW: PrintDesign[] = RAW_PRINT_DESIGNS;

/**
 * The registry every read path sees. While `MOUNT_TEMPORARILY_DISABLED` is on,
 * passe-partout is withdrawn from every design (see print-availability.ts) —
 * the per-design `mountAvailable: true` literals above stay as authored truth.
 */
export const PRINT_DESIGNS: PrintDesign[] = MOUNT_TEMPORARILY_DISABLED
  ? RAW_PRINT_DESIGNS.map((d) => (d.mountAvailable ? { ...d, mountAvailable: false } : d))
  : RAW_PRINT_DESIGNS;

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
