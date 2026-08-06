/* ============================================================
   Print collections — visually curated groups for /fine-art-prints.
   ------------------------------------------------------------
   Membership is keyed by design id, NOT stored on PrintDesign: under
   CATALOG_SOURCE=db the catalog mapper rebuilds designs field-by-field
   from DB rows, so a registry-only field would be silently dropped
   (and would break the catalog-parity round-trip). Grouping whatever
   getPrintDesigns() returns keeps code and db mode identical.
   Curated 2026-08-06 from the 43 full-bleed paintings (fap005–fap047):
   palette family first, motif second.
   ============================================================ */
import type { PrintDesign } from './types';

export type PrintCollectionSlug =
  | 'ultramaryna'
  | 'miedz'
  | 'agat'
  | 'szalwia'
  | 'nokturn'
  | 'inne';

/** Fallback bucket for designs not listed in any collection (legacy
    fap01–fap03 today; also any future DB-created design). Permanent slug. */
export const UNASSIGNED_COLLECTION: PrintCollectionSlug = 'inne';

/** Ordered collections; designIds sets the display order within each. */
export const PRINT_COLLECTIONS: ReadonlyArray<{
  slug: PrintCollectionSlug;
  designIds: readonly string[];
}> = [
  {
    // Periwinkle & cobalt blues — vivid rings and pebble forms.
    slug: 'ultramaryna',
    designIds: ['fap029', 'fap033', 'fap037', 'fap036', 'fap038', 'fap027', 'fap045', 'fap039', 'fap014'],
  },
  {
    // Rust/copper stitched ribbons coiling over slate-grey washes.
    slug: 'miedz',
    designIds: ['fap016', 'fap030', 'fap020', 'fap043', 'fap018', 'fap015', 'fap035', 'fap042'],
  },
  {
    // Geode/mineral forms — navy, peach, terracotta, gold leaf.
    slug: 'agat',
    designIds: ['fap009', 'fap010', 'fap008', 'fap007', 'fap019', 'fap011', 'fap012', 'fap031', 'fap034'],
  },
  {
    // Olive/sage greens with pale blue and golden ochre.
    slug: 'szalwia',
    designIds: ['fap005', 'fap006', 'fap026', 'fap041', 'fap024', 'fap021'],
  },
  {
    // Smoky neutrals, sepia washes, moody horizons.
    slug: 'nokturn',
    designIds: ['fap017', 'fap013', 'fap025', 'fap022', 'fap040', 'fap046', 'fap023', 'fap028', 'fap032', 'fap044', 'fap047'],
  },
];

const COLLECTION_BY_ID: ReadonlyMap<string, PrintCollectionSlug> = new Map(
  PRINT_COLLECTIONS.flatMap((c) => c.designIds.map((id) => [id, c.slug] as const)),
);

/** Collection slug for a design id, or undefined when unassigned. */
export function collectionOf(id: string): PrintCollectionSlug | undefined {
  return COLLECTION_BY_ID.get(id);
}

/** Group designs (as returned by getPrintDesigns()) into display order:
    collection order, designIds order within, then the 'inne' fallback
    bucket (in input order) for anything unassigned. Empty groups are
    dropped — an unpublished member simply doesn't render. */
export function groupPrintDesigns(
  designs: PrintDesign[],
): { slug: PrintCollectionSlug; designs: PrintDesign[] }[] {
  const byId = new Map(designs.map((d) => [d.id, d]));
  const groups = PRINT_COLLECTIONS.map(({ slug, designIds }) => ({
    slug,
    designs: designIds.flatMap((id) => byId.get(id) ?? []),
  }));
  const rest = designs.filter((d) => !COLLECTION_BY_ID.has(d.id));
  groups.push({ slug: UNASSIGNED_COLLECTION, designs: rest });
  return groups.filter((g) => g.designs.length > 0);
}
