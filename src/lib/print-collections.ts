/* ============================================================
   Print collections — visually curated groups for /fine-art-prints.
   ------------------------------------------------------------
   Membership is keyed by design id, NOT stored on PrintDesign: under
   CATALOG_SOURCE=db the catalog mapper rebuilds designs field-by-field
   from DB rows, so a registry-only field would be silently dropped
   (and would break the catalog-parity round-trip). Grouping whatever
   getPrintDesigns() returns keeps code and db mode identical.
   Curated collections come directly from the print curation map so their
   names, membership, and display order have one source of truth. Anything
   unknown to that map (for example a DB-created design) remains safely in
   the localized fallback bucket.
   ============================================================ */
import { PRINT_COLLECTION_DEFINITIONS } from './print-curation';
import type { PrintDesign } from './types';

export type PrintCollectionSlug = string;

/** Fallback bucket for designs not listed in any collection, including
    unexpected DB-created designs. Permanent slug. */
export const UNASSIGNED_COLLECTION: PrintCollectionSlug = 'inne';

/** Ordered collections; designIds sets the display order within each. */
export const PRINT_COLLECTIONS = PRINT_COLLECTION_DEFINITIONS;

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
): { slug: PrintCollectionSlug; name?: string; designs: PrintDesign[] }[] {
  const byId = new Map(designs.map((d) => [d.id, d]));
  const groups: { slug: PrintCollectionSlug; name?: string; designs: PrintDesign[] }[] = PRINT_COLLECTIONS.map(({ slug, name, designIds }) => ({
    slug,
    name,
    designs: designIds.flatMap((id) => byId.get(id) ?? []),
  }));
  const rest = designs.filter((d) => !COLLECTION_BY_ID.has(d.id));
  groups.push({ slug: UNASSIGNED_COLLECTION, name: undefined, designs: rest });
  return groups.filter((g) => g.designs.length > 0);
}
