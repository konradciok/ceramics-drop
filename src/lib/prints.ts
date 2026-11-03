import { cache } from 'react';
import type { PrintDesign, PrintVariantSelection } from './types';
import { variantKey } from './print-cart';
import { catalogSource } from './catalog/source';
import { readWithFallback } from './supabase-timeout';
import { MOUNT_TEMPORARILY_DISABLED } from './print-availability';
import { ACTIVE_PRINT_CURATION, DRAFT_PRINT_CURATION, RETIRED_PRINT_CURATION, validatePrintRegistry, catalogStatusForPrint } from './print-curation';

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
// re-exports 2026-08-17 (all now ≥8400x12000 at ~7:10). Publication and
// display order are now applied exclusively from print-curation.ts.
// `noteIndex` is 0-based, matching array position directly. The 41
// notes["fine-art-prints"] entries in messages/*.json contain the localized
// customer-facing descriptions, aligned to this registry by `noteIndex`.
type PrintSourceDesign = Omit<PrintDesign, 'num' | 'published'>;

const SOURCE_PRINT_DESIGNS: PrintSourceDesign[] = [
  {
    id: 'fap001',
    category: 'fine-art-prints',
    image: '/uploads/fap-001.webp',
    editorialGallery: ['/uploads/fap-001-life-01.webp', '/uploads/fap-001-life-02.webp', '/uploads/fap-001-life-03.webp'],
    noteIndex: 0,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap002',
    category: 'fine-art-prints',
    image: '/uploads/fap-002.webp',
    editorialGallery: ['/uploads/fap-002-life-01.webp', '/uploads/fap-002-life-02.webp', '/uploads/fap-002-life-03.webp'],
    noteIndex: 1,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap003',
    category: 'fine-art-prints',
    image: '/uploads/fap-003.webp',
    editorialGallery: ['/uploads/fap-003-life-01.webp', '/uploads/fap-003-life-02.webp', '/uploads/fap-003-life-03.webp'],
    noteIndex: 2,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap004',
    category: 'fine-art-prints',
    image: '/uploads/fap-004.webp',
    editorialGallery: ['/uploads/fap-004-life-01.webp', '/uploads/fap-004-life-02.webp', '/uploads/fap-004-life-03.webp'],
    noteIndex: 3,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap005',
    category: 'fine-art-prints',
    image: '/uploads/fap-005.webp',
    editorialGallery: ['/uploads/fap-005-life-01.webp', '/uploads/fap-005-life-02.webp', '/uploads/fap-005-life-03.webp'],
    noteIndex: 4,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap006',
    category: 'fine-art-prints',
    image: '/uploads/fap-006.webp',
    editorialGallery: ['/uploads/fap-006-life-01.webp', '/uploads/fap-006-life-02.webp', '/uploads/fap-006-life-03.webp'],
    noteIndex: 5,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap007',
    category: 'fine-art-prints',
    image: '/uploads/fap-007.webp',
    editorialGallery: ['/uploads/fap-007-life-01.webp', '/uploads/fap-007-life-02.webp', '/uploads/fap-007-life-03.webp'],
    noteIndex: 6,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap008',
    category: 'fine-art-prints',
    image: '/uploads/fap-008.webp',
    editorialGallery: ['/uploads/fap-008-life-01.webp', '/uploads/fap-008-life-02.webp', '/uploads/fap-008-life-03.webp'],
    noteIndex: 7,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap009',
    category: 'fine-art-prints',
    image: '/uploads/fap-009.webp',
    editorialGallery: ['/uploads/fap-009-life-01.webp', '/uploads/fap-009-life-02.webp', '/uploads/fap-009-life-03.webp'],
    noteIndex: 8,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap010',
    category: 'fine-art-prints',
    image: '/uploads/fap-010.webp',
    editorialGallery: ['/uploads/fap-010-life-01.webp', '/uploads/fap-010-life-02.webp', '/uploads/fap-010-life-03.webp'],
    noteIndex: 9,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap011',
    category: 'fine-art-prints',
    image: '/uploads/fap-011.webp',
    editorialGallery: ['/uploads/fap-011-life-01.webp', '/uploads/fap-011-life-02.webp', '/uploads/fap-011-life-03.webp'],
    noteIndex: 10,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap012',
    category: 'fine-art-prints',
    image: '/uploads/fap-012.webp',
    editorialGallery: ['/uploads/fap-012-life-01.webp', '/uploads/fap-012-life-02.webp', '/uploads/fap-012-life-03.webp'],
    noteIndex: 11,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap013',
    category: 'fine-art-prints',
    image: '/uploads/fap-013.webp',
    editorialGallery: ['/uploads/fap-013-life-01.webp', '/uploads/fap-013-life-02.webp', '/uploads/fap-013-life-03.webp'],
    noteIndex: 12,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap014',
    category: 'fine-art-prints',
    image: '/uploads/fap-014.webp',
    editorialGallery: ['/uploads/fap-014-life-01.webp', '/uploads/fap-014-life-02.webp', '/uploads/fap-014-life-03.webp'],
    noteIndex: 13,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap015',
    category: 'fine-art-prints',
    image: '/uploads/fap-015.webp',
    editorialGallery: ['/uploads/fap-015-life-01.webp', '/uploads/fap-015-life-02.webp', '/uploads/fap-015-life-03.webp'],
    noteIndex: 14,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap016',
    category: 'fine-art-prints',
    image: '/uploads/fap-016.webp',
    editorialGallery: ['/uploads/fap-016-life-01.webp', '/uploads/fap-016-life-02.webp', '/uploads/fap-016-life-03.webp'],
    noteIndex: 15,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap017',
    category: 'fine-art-prints',
    image: '/uploads/fap-017.webp',
    editorialGallery: ['/uploads/fap-017-life-01.webp', '/uploads/fap-017-life-02.webp', '/uploads/fap-017-life-03.webp'],
    noteIndex: 16,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap018',
    category: 'fine-art-prints',
    image: '/uploads/fap-018.webp',
    editorialGallery: ['/uploads/fap-018-life-01.webp', '/uploads/fap-018-life-02.webp', '/uploads/fap-018-life-03.webp'],
    noteIndex: 17,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap019',
    category: 'fine-art-prints',
    image: '/uploads/fap-019.webp',
    editorialGallery: ['/uploads/fap-019-life-01.webp', '/uploads/fap-019-life-02.webp', '/uploads/fap-019-life-03.webp'],
    noteIndex: 18,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap020',
    category: 'fine-art-prints',
    image: '/uploads/fap-020.webp',
    editorialGallery: ['/uploads/fap-020-life-01.webp', '/uploads/fap-020-life-02.webp', '/uploads/fap-020-life-03.webp'],
    noteIndex: 19,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap021',
    category: 'fine-art-prints',
    image: '/uploads/fap-021.webp',
    editorialGallery: ['/uploads/fap-021-life-01.webp', '/uploads/fap-021-life-02.webp', '/uploads/fap-021-life-03.webp'],
    noteIndex: 20,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap022',
    category: 'fine-art-prints',
    image: '/uploads/fap-022.webp',
    editorialGallery: ['/uploads/fap-022-life-01.webp', '/uploads/fap-022-life-02.webp', '/uploads/fap-022-life-03.webp'],
    noteIndex: 21,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap023',
    category: 'fine-art-prints',
    image: '/uploads/fap-023.webp',
    editorialGallery: ['/uploads/fap-023-life-01.webp', '/uploads/fap-023-life-02.webp', '/uploads/fap-023-life-03.webp'],
    noteIndex: 22,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap024',
    category: 'fine-art-prints',
    image: '/uploads/fap-024.webp',
    editorialGallery: ['/uploads/fap-024-life-01.webp', '/uploads/fap-024-life-02.webp', '/uploads/fap-024-life-03.webp'],
    noteIndex: 23,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap025',
    category: 'fine-art-prints',
    image: '/uploads/fap-025.webp',
    editorialGallery: ['/uploads/fap-025-life-01.webp', '/uploads/fap-025-life-02.webp', '/uploads/fap-025-life-03.webp'],
    noteIndex: 24,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap026',
    category: 'fine-art-prints',
    image: '/uploads/fap-026.webp',
    editorialGallery: ['/uploads/fap-026-life-01.webp', '/uploads/fap-026-life-02.webp', '/uploads/fap-026-life-03.webp'],
    noteIndex: 25,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap027',
    category: 'fine-art-prints',
    image: '/uploads/fap-027.webp',
    editorialGallery: ['/uploads/fap-027-life-01.webp', '/uploads/fap-027-life-02.webp', '/uploads/fap-027-life-03.webp'],
    noteIndex: 26,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap028',
    category: 'fine-art-prints',
    image: '/uploads/fap-028.webp',
    editorialGallery: ['/uploads/fap-028-life-01.webp', '/uploads/fap-028-life-02.webp', '/uploads/fap-028-life-03.webp'],
    noteIndex: 27,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap029',
    category: 'fine-art-prints',
    image: '/uploads/fap-029.webp',
    editorialGallery: ['/uploads/fap-029-life-01.webp', '/uploads/fap-029-life-02.webp', '/uploads/fap-029-life-03.webp'],
    noteIndex: 28,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap030',
    category: 'fine-art-prints',
    image: '/uploads/fap-030.webp',
    editorialGallery: ['/uploads/fap-030-life-01.webp', '/uploads/fap-030-life-02.webp', '/uploads/fap-030-life-03.webp'],
    noteIndex: 29,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap031',
    category: 'fine-art-prints',
    image: '/uploads/fap-031.webp',
    editorialGallery: ['/uploads/fap-031-life-01.webp', '/uploads/fap-031-life-02.webp', '/uploads/fap-031-life-03.webp'],
    noteIndex: 30,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap032',
    category: 'fine-art-prints',
    image: '/uploads/fap-032.webp',
    editorialGallery: ['/uploads/fap-032-life-01.webp', '/uploads/fap-032-life-02.webp', '/uploads/fap-032-life-03.webp'],
    noteIndex: 31,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap033',
    category: 'fine-art-prints',
    image: '/uploads/fap-033.webp',
    editorialGallery: ['/uploads/fap-033-life-01.webp', '/uploads/fap-033-life-02.webp', '/uploads/fap-033-life-03.webp'],
    noteIndex: 32,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap034',
    category: 'fine-art-prints',
    image: '/uploads/fap-034.webp',
    editorialGallery: ['/uploads/fap-034-life-01.webp', '/uploads/fap-034-life-02.webp', '/uploads/fap-034-life-03.webp'],
    noteIndex: 33,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap035',
    category: 'fine-art-prints',
    image: '/uploads/fap-035.webp',
    editorialGallery: ['/uploads/fap-035-life-01.webp', '/uploads/fap-035-life-02.webp', '/uploads/fap-035-life-03.webp'],
    noteIndex: 34,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap036',
    category: 'fine-art-prints',
    image: '/uploads/fap-036.webp',
    editorialGallery: ['/uploads/fap-036-life-01.webp', '/uploads/fap-036-life-02.webp', '/uploads/fap-036-life-03.webp'],
    noteIndex: 35,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap037',
    category: 'fine-art-prints',
    image: '/uploads/fap-037.webp',
    editorialGallery: ['/uploads/fap-037-life-01.webp', '/uploads/fap-037-life-02.webp', '/uploads/fap-037-life-03.webp'],
    noteIndex: 36,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap038',
    category: 'fine-art-prints',
    image: '/uploads/fap-038.webp',
    editorialGallery: ['/uploads/fap-038-life-01.webp', '/uploads/fap-038-life-02.webp', '/uploads/fap-038-life-03.webp'],
    noteIndex: 37,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap039',
    category: 'fine-art-prints',
    image: '/uploads/fap-039.webp',
    editorialGallery: ['/uploads/fap-039-life-01.webp', '/uploads/fap-039-life-02.webp', '/uploads/fap-039-life-03.webp'],
    noteIndex: 38,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap040',
    category: 'fine-art-prints',
    image: '/uploads/fap-040.webp',
    editorialGallery: ['/uploads/fap-040-life-01.webp', '/uploads/fap-040-life-02.webp', '/uploads/fap-040-life-03.webp'],
    noteIndex: 39,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap041',
    category: 'fine-art-prints',
    image: '/uploads/fap-041.webp',
    editorialGallery: ['/uploads/fap-041-life-01.webp', '/uploads/fap-041-life-02.webp', '/uploads/fap-041-life-03.webp'],
    noteIndex: 40,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap042',
    category: 'fine-art-prints',
    image: '/uploads/fap-042.webp',
    editorialGallery: ['/uploads/fap-042-life-01.webp', '/uploads/fap-042-life-02.webp', '/uploads/fap-042-life-03.webp'],
    noteIndex: 41,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap043',
    category: 'fine-art-prints',
    image: '/uploads/fap-043.webp',
    editorialGallery: ['/uploads/fap-043-life-01.webp', '/uploads/fap-043-life-02.webp', '/uploads/fap-043-life-03.webp'],
    noteIndex: 42,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap044',
    category: 'fine-art-prints',
    image: '/uploads/fap-044.webp',
    editorialGallery: ['/uploads/fap-044-life-01.webp', '/uploads/fap-044-life-02.webp', '/uploads/fap-044-life-03.webp'],
    noteIndex: 43,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap045',
    category: 'fine-art-prints',
    image: '/uploads/fap-045.webp',
    editorialGallery: ['/uploads/fap-045-life-01.webp', '/uploads/fap-045-life-02.webp', '/uploads/fap-045-life-03.webp'],
    noteIndex: 44,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap046',
    category: 'fine-art-prints',
    image: '/uploads/fap-046.webp',
    editorialGallery: ['/uploads/fap-046-life-01.webp', '/uploads/fap-046-life-02.webp', '/uploads/fap-046-life-03.webp'],
    noteIndex: 45,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap047',
    category: 'fine-art-prints',
    image: '/uploads/fap-047.webp',
    editorialGallery: ['/uploads/fap-047-life-01.webp', '/uploads/fap-047-life-02.webp', '/uploads/fap-047-life-03.webp'],
    noteIndex: 46,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap048',
    category: 'fine-art-prints',
    image: '/uploads/fap-048.webp',
    editorialGallery: ['/uploads/fap-048-life-01.webp', '/uploads/fap-048-life-02.webp', '/uploads/fap-048-life-03.webp'],
    noteIndex: 47,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap049',
    category: 'fine-art-prints',
    image: '/uploads/fap-049.webp',
    editorialGallery: ['/uploads/fap-049-life-01.webp', '/uploads/fap-049-life-02.webp', '/uploads/fap-049-life-03.webp'],
    noteIndex: 48,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap050',
    category: 'fine-art-prints',
    image: '/uploads/fap-050.webp',
    editorialGallery: ['/uploads/fap-050-life-01.webp', '/uploads/fap-050-life-02.webp', '/uploads/fap-050-life-03.webp'],
    noteIndex: 49,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap051',
    category: 'fine-art-prints',
    image: '/uploads/fap-051.webp',
    editorialGallery: ['/uploads/fap-051-life-01.webp', '/uploads/fap-051-life-02.webp', '/uploads/fap-051-life-03.webp'],
    noteIndex: 50,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap052',
    category: 'fine-art-prints',
    image: '/uploads/fap-052.webp',
    editorialGallery: ['/uploads/fap-052-life-01.webp', '/uploads/fap-052-life-02.webp', '/uploads/fap-052-life-03.webp'],
    noteIndex: 51,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap053',
    category: 'fine-art-prints',
    image: '/uploads/fap-053.webp',
    editorialGallery: ['/uploads/fap-053-life-01.webp', '/uploads/fap-053-life-02.webp', '/uploads/fap-053-life-03.webp'],
    noteIndex: 52,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap054',
    category: 'fine-art-prints',
    image: '/uploads/fap-054.webp',
    editorialGallery: ['/uploads/fap-054-life-01.webp', '/uploads/fap-054-life-02.webp', '/uploads/fap-054-life-03.webp'],
    noteIndex: 53,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap055',
    category: 'fine-art-prints',
    image: '/uploads/fap-055.webp',
    editorialGallery: ['/uploads/fap-055-life-01.webp', '/uploads/fap-055-life-02.webp', '/uploads/fap-055-life-03.webp'],
    noteIndex: 54,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap056',
    category: 'fine-art-prints',
    image: '/uploads/fap-056.webp',
    editorialGallery: ['/uploads/fap-056-life-01.webp', '/uploads/fap-056-life-02.webp', '/uploads/fap-056-life-03.webp'],
    noteIndex: 55,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap057',
    category: 'fine-art-prints',
    image: '/uploads/fap-057.webp',
    editorialGallery: ['/uploads/fap-057-life-01.webp', '/uploads/fap-057-life-02.webp', '/uploads/fap-057-life-03.webp'],
    noteIndex: 56,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
  {
    id: 'fap058',
    category: 'fine-art-prints',
    image: '/uploads/fap-058.webp',
    editorialGallery: ['/uploads/fap-058-life-01.webp', '/uploads/fap-058-life-02.webp', '/uploads/fap-058-life-03.webp'],
    noteIndex: 57,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'natural', 'brown'],
    mountAvailable: false,
    mockups: true,
  },
];

/**
 * Ungated designs — authored truth, mount included. Seed-only: the catalog
 * backfill (`src/lib/catalog/seed.ts`) must keep emitting every structurally
 * valid variant row so a run during the mount-disabled window reproduces the
 * existing DB exactly. Storefront/checkout readers use `PRINT_DESIGNS`.
 */
const CURATED_PRINTS = [...ACTIVE_PRINT_CURATION, ...DRAFT_PRINT_CURATION, ...RETIRED_PRINT_CURATION];
validatePrintRegistry(
  SOURCE_PRINT_DESIGNS.map(({ id }) => id),
  CURATED_PRINTS.map(({ productId }) => productId),
);

const SOURCE_BY_ID = new Map(SOURCE_PRINT_DESIGNS.map((design) => [design.id, design]));

/** Ungated designs with display state projected exclusively from the approved curation map. */
export const PRINT_DESIGNS_RAW: PrintDesign[] = CURATED_PRINTS.map((curation) => {
  const source = SOURCE_BY_ID.get(curation.productId);
  if (!source) throw new Error(`Missing source metadata for curated print ${curation.productId}`);
  return {
    ...source,
    num: curation.number ?? curation.sourceNumber,
    published: catalogStatusForPrint(curation.productId) === 'active',
  };
});

/**
 * The registry every read path sees. While `MOUNT_TEMPORARILY_DISABLED` is on,
 * passe-partout is withdrawn from every design (see print-availability.ts) —
 * the per-design `mountAvailable` literals above stay as authored truth.
 */
export const PRINT_DESIGNS: PrintDesign[] = MOUNT_TEMPORARILY_DISABLED
  ? PRINT_DESIGNS_RAW.map((d) => (d.mountAvailable ? { ...d, mountAvailable: false } : d))
  : PRINT_DESIGNS_RAW;

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

/** Content preparation includes drafts, without making them sellable. */
export function registryContentPrintDesigns(): PrintDesign[] {
  return PRINT_DESIGNS.filter((d) => catalogStatusForPrint(d.id) !== 'archived');
}

export function registryPrintById(id: string): PrintDesign | undefined {
  return BY_ID.get(id);
}

/**
 * Async catalog core — 'code' returns the registry designs; 'db' reads the
 * catalog shadow tables directly (including drafts). Dynamic import of
 * the DB path keeps Cloudflare-only code out of the default 'code' flag and
 * breaks the load → repository → seed → prints import cycle.
 */
// Share successes and fallbacks across metadata and components in one render.
// React clears this cache between requests; route handlers still read directly.
const loadPrintCatalog = cache(async (): Promise<{ designs: PrintDesign[]; byId: Map<string, PrintDesign> }> => {
  if (catalogSource() === 'code') {
    return { designs: PRINT_DESIGNS, byId: BY_ID };
  }
  // Same resilience default as loadCeramicCatalog: fall back to the registry
  // on a DB read failure (including a bounded Supabase timeout) rather than
  // breaking print PDPs + checkout.
  return readWithFallback('print-catalog', async () => {
    const { loadPrintDesignsFromDb } = await import('./catalog/load');
    const designs = await loadPrintDesignsFromDb();
    return { designs, byId: new Map(designs.map((d) => [d.id, d])) };
  }, { designs: PRINT_DESIGNS, byId: BY_ID });
});

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
