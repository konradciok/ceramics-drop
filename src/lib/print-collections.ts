/* ============================================================
   Print collections — visually curated groups for /fine-art-prints.
   ------------------------------------------------------------
   Membership is keyed by design id, NOT stored on PrintDesign: under
   CATALOG_SOURCE=db the catalog mapper rebuilds designs field-by-field
   from DB rows, so a registry-only field would be silently dropped
   (and would break the catalog-parity round-trip). Grouping whatever
   getPrintDesigns() returns keeps code and db mode identical.
   The 2026-08-06 curation (fap005–fap047, palette family first, motif
   second) was retired with the 2026-08-17 registry reset — those ids no
   longer exist. PRINT_COLLECTIONS is deliberately empty until the new
   fap001–fap041 batch gets a real curatorial pass; every published design
   falls into the UNASSIGNED_COLLECTION ('inne') fallback bucket in the
   meantime, which groupPrintDesigns already handles (see its tests).
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
}> = [];

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
