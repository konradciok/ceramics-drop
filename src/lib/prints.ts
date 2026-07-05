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
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'white', 'natural'],
    mountAvailable: true,
    published: true,
  },
  {
    id: 'fap02',
    category: 'fine-art-prints',
    num: '02',
    image: '/uploads/fap-02.webp',
    gallery: ['/uploads/fap-02-room.webp'],
    noteIndex: 1,
    sizes: ['30x40', '50x70'],
    frameColours: ['black', 'white'],
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
    frameColours: ['black', 'white', 'natural'],
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
    frameColours: ['black', 'white', 'natural'],
    mountAvailable: true,
    published: false,
  },
];

const BY_ID = new Map(PRINT_DESIGNS.map((d) => [d.id, d]));

/** Published designs in registry order. */
export function getPrintDesigns(): PrintDesign[] {
  return PRINT_DESIGNS.filter((d) => d.published);
}

/** Resolve by id including unpublished — lets checkout reject hidden vs unknown. */
export function getPrintById(id: string): PrintDesign | undefined {
  return BY_ID.get(id);
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
