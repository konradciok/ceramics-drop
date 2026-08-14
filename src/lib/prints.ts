import type { PrintDesign, PrintVariantSelection } from './types';
import { variantKey } from './print-cart';
import { catalogSource } from './catalog/source';
import { MOUNT_TEMPORARILY_DISABLED } from './print-availability';

const RAW_PRINT_DESIGNS: PrintDesign[] = [
  // fap01–fap03 (legacy ceramic-motif posters) withdrawn 2026-08-06: the
  // storefront sells only pipeline-backed production designs (fap005+).
  // fap02/fap03 never had fulfilment assets (checkout failed closed on every
  // variant) and fap01's brown variants were unassigned. Entries kept —
  // ids, noteIndexes 0–2, and uploads stay reserved; re-publishing requires
  // restoring design/print-assets/fap0N/ sources and a full
  // prepare → upload → verify → publish run per design.
  {
    id: 'fap01',
    category: 'fine-art-prints',
    num: '01',
    image: '/uploads/fap-01.webp',
    noteIndex: 0,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
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
    // without upscaling. A prepare + publish run never happened — do it
    // before any re-publish (checkout fails closed with
    // print_asset_unavailable otherwise).
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: false,
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
    published: false,
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
    num: '1',
    image: '/uploads/fap-005.webp',
    noteIndex: 3,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap006',
    category: 'fine-art-prints',
    num: '2',
    image: '/uploads/fap-006.webp',
    noteIndex: 4,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap007',
    category: 'fine-art-prints',
    num: '3',
    image: '/uploads/fap-007.webp',
    noteIndex: 5,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap008',
    category: 'fine-art-prints',
    num: '4',
    image: '/uploads/fap-008.webp',
    noteIndex: 6,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap009',
    category: 'fine-art-prints',
    num: '5',
    image: '/uploads/fap-009.webp',
    noteIndex: 7,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  // Full-bleed paintings 06-43 (docs/plans/full-bleed-print-assets-plan.md),
  // onboarded via print-assets:onboard from design/uploads/master-images-prints/.
  // Same caveats as the 01-05 batch above: placeholder titles, note copy still
  // needed, published:false until the per-design pipeline runs.
  {
    id: 'fap010',
    category: 'fine-art-prints',
    num: '6',
    image: '/uploads/fap-010.webp',
    noteIndex: 8,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap011',
    category: 'fine-art-prints',
    num: '7',
    image: '/uploads/fap-011.webp',
    noteIndex: 9,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap012',
    category: 'fine-art-prints',
    num: '8',
    image: '/uploads/fap-012.webp',
    noteIndex: 10,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap013',
    category: 'fine-art-prints',
    num: '9',
    image: '/uploads/fap-013.webp',
    noteIndex: 11,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap014',
    category: 'fine-art-prints',
    num: '10',
    image: '/uploads/fap-014.webp',
    noteIndex: 12,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap015',
    category: 'fine-art-prints',
    num: '11',
    image: '/uploads/fap-015.webp',
    noteIndex: 13,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap016',
    category: 'fine-art-prints',
    num: '12',
    image: '/uploads/fap-016.webp',
    noteIndex: 14,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap017',
    category: 'fine-art-prints',
    num: '13',
    image: '/uploads/fap-017.webp',
    noteIndex: 15,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap018',
    category: 'fine-art-prints',
    num: '14',
    image: '/uploads/fap-018.webp',
    noteIndex: 16,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap019',
    category: 'fine-art-prints',
    num: '15',
    image: '/uploads/fap-019.webp',
    noteIndex: 17,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap020',
    category: 'fine-art-prints',
    num: '16',
    image: '/uploads/fap-020.webp',
    noteIndex: 18,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap021',
    category: 'fine-art-prints',
    num: '17',
    image: '/uploads/fap-021.webp',
    noteIndex: 19,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap022',
    category: 'fine-art-prints',
    num: '18',
    image: '/uploads/fap-022.webp',
    noteIndex: 20,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap023',
    category: 'fine-art-prints',
    num: '19',
    image: '/uploads/fap-023.webp',
    noteIndex: 21,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap024',
    category: 'fine-art-prints',
    num: '20',
    image: '/uploads/fap-024.webp',
    noteIndex: 22,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap025',
    category: 'fine-art-prints',
    num: '21',
    image: '/uploads/fap-025.webp',
    noteIndex: 23,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap026',
    category: 'fine-art-prints',
    num: '22',
    image: '/uploads/fap-026.webp',
    noteIndex: 24,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap027',
    category: 'fine-art-prints',
    num: '23',
    image: '/uploads/fap-027.webp',
    noteIndex: 25,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap028',
    category: 'fine-art-prints',
    num: '24',
    image: '/uploads/fap-028.webp',
    noteIndex: 26,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap029',
    category: 'fine-art-prints',
    num: '25',
    image: '/uploads/fap-029.webp',
    noteIndex: 27,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap030',
    category: 'fine-art-prints',
    num: '26',
    image: '/uploads/fap-030.webp',
    noteIndex: 28,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap031',
    category: 'fine-art-prints',
    num: '27',
    image: '/uploads/fap-031.webp',
    noteIndex: 29,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap032',
    category: 'fine-art-prints',
    num: '28',
    image: '/uploads/fap-032.webp',
    noteIndex: 30,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap033',
    category: 'fine-art-prints',
    num: '29',
    image: '/uploads/fap-033.webp',
    noteIndex: 31,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap034',
    category: 'fine-art-prints',
    num: '30',
    image: '/uploads/fap-034.webp',
    noteIndex: 32,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap035',
    category: 'fine-art-prints',
    num: '31',
    image: '/uploads/fap-035.webp',
    noteIndex: 33,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap036',
    category: 'fine-art-prints',
    num: '32',
    image: '/uploads/fap-036.webp',
    noteIndex: 34,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap037',
    category: 'fine-art-prints',
    num: '33',
    image: '/uploads/fap-037.webp',
    noteIndex: 35,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap038',
    category: 'fine-art-prints',
    num: '34',
    image: '/uploads/fap-038.webp',
    noteIndex: 36,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap039',
    category: 'fine-art-prints',
    num: '35',
    image: '/uploads/fap-039.webp',
    noteIndex: 37,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap040',
    category: 'fine-art-prints',
    num: '36',
    image: '/uploads/fap-040.webp',
    noteIndex: 38,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap041',
    category: 'fine-art-prints',
    num: '37',
    image: '/uploads/fap-041.webp',
    noteIndex: 39,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap042',
    category: 'fine-art-prints',
    num: '38',
    image: '/uploads/fap-042.webp',
    noteIndex: 40,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap043',
    category: 'fine-art-prints',
    num: '39',
    image: '/uploads/fap-043.webp',
    noteIndex: 41,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap044',
    category: 'fine-art-prints',
    num: '40',
    image: '/uploads/fap-044.webp',
    noteIndex: 42,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap045',
    category: 'fine-art-prints',
    num: '41',
    image: '/uploads/fap-045.webp',
    noteIndex: 43,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap046',
    category: 'fine-art-prints',
    num: '42',
    image: '/uploads/fap-046.webp',
    noteIndex: 44,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
    published: true,
    mockups: true,
  },
  {
    id: 'fap047',
    category: 'fine-art-prints',
    num: '43',
    image: '/uploads/fap-047.webp',
    noteIndex: 45,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: true,
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
