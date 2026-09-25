import source from '../../config/print-catalog-curation.json';

/**
 * Static fallback source for print-collection naming/grouping — retained
 * deliberately, not dead code.
 *
 * As of the fine-art-collections migration (2026-09-16 plans 1+2), every
 * naming/grouping caller in this codebase (cart, invoices, analytics
 * overrides, feed, admin listings, account history, the storefront pages)
 * passes an explicit, CMS-loaded `definitions` array — sourced from
 * `loadPrintCollectionDefinitions()` in print-collections.ts — to
 * `printDisplayName`/`groupPrintDesigns`. This JSON-derived
 * `PRINT_COLLECTION_DEFINITIONS` export remains only as:
 *   1. The parameter default those functions fall back to. This isn't a
 *      hypothetical for some future caller — it's already live:
 *      `analytics.ts`'s print-item builders call `printDisplayName`
 *      without a `definitions` argument whenever no `nameOverride`/
 *      `itemName` override is supplied (e.g. the checkout-return
 *      purchase-confirmation flow), so this default is exercised in
 *      production today. `loadPrintCollectionDefinitions()` itself also
 *      falls back to it if the CMS-backed DB read fails or times out (see
 *      print-collections.ts's `readWithFallback` call).
 *   2. The same underlying JSON `source` this file also derives
 *      `PRINT_CURATION`/`ACTIVE_PRINT_CURATION`/`RETIRED_PRINT_CURATION`/
 *      `curationForProduct` from (independently, not through
 *      `PRINT_COLLECTION_DEFINITIONS`) — exports unrelated to collection
 *      naming/grouping that still power live, unaffected per-print
 *      publication-status consumers: `catalog/seed.ts`'s
 *      `catalogStatusForPrint` call and `src/lib/prints.ts`'s
 *      published/retired registry construction (`curationForProduct()` at
 *      prints.ts:504, explicitly out of scope per Plan 1's Global
 *      Constraints).
 * Neither reason makes this file or its exports dead code — do not delete
 * `config/print-catalog-curation.json` or remove any export here without
 * separately deciding to make `definitions` a required parameter
 * everywhere (a bigger, separate decision, out of scope for this plan).
 */

export type PrintCuration = {
  sourceNumber: string;
  productId: string;
  number?: string;
  collectionSlug?: string;
  duplicateOf?: string;
  reason?: string;
};

export type PrintCollectionDefinition = {
  slug: string;
  name: string;
  designIds: string[];
  prints: PrintCuration[];
};

export type PrintCurationSource = {
  schemaVersion: number;
  collections: Array<{ slug: string; name: string; prints: Array<{ sourceNumber: string; productId: string; number: string }> }>;
  retired: Array<{ sourceNumber: string; productId: string; duplicateOf: string; reason: string }>;
};

const input = source as PrintCurationSource;

function fail(message: string): never {
  throw new Error(`Invalid print curation map: ${message}`);
}

export function validatePrintCuration(input: PrintCurationSource): void {
  if (input.schemaVersion !== 1) fail(`unsupported schemaVersion ${input.schemaVersion}`);
  if (!Array.isArray(input.collections) || !Array.isArray(input.retired)) fail('collections and retired must be arrays');
  const expectedNames = ['Ostrea', 'Gestures', 'Linea', 'Horizons', 'Portals', 'Signs', 'Ciala', 'Balance', 'Verticles'];
  if (input.collections.map(({ name }) => name).join() !== expectedNames.join()) {
    fail('collection names must be exactly Ostrea, Gestures, Linea, Horizons, Portals, Signs, Ciala, Balance, Verticles');
  }
  if (input.retired.map(({ productId }) => productId).join() !== 'fap029,fap037') {
    fail('retired IDs must be exactly fap029 and fap037');
  }
  const activeIds = input.collections.flatMap(({ prints }) => prints.map(({ productId }) => productId));
  const allIds = [...activeIds, ...input.retired.map(({ productId }) => productId)].sort();
  const expectedIds = Array.from({ length: 41 }, (_, index) => `fap${String(index + 1).padStart(3, '0')}`);
  if (allIds.join() !== expectedIds.join()) fail('product ID universe must be fap001 through fap041');
  const active: PrintCuration[] = input.collections.flatMap((collection) => {
  if (!collection.slug || !collection.name) fail('every collection requires slug and name');
  return collection.prints.map((item) => ({ ...item, collectionSlug: collection.slug }));
  });
  const retired: PrintCuration[] = input.retired.map((item) => ({ ...item }));
  const all = [...active, ...retired];

  for (const item of all) {
  if (item.productId !== `fap${item.sourceNumber}`) fail(`${item.productId} must match sourceNumber ${item.sourceNumber}`);
  }
  if (new Set(all.map((item) => item.productId)).size !== 41) fail('expected 41 unique product IDs');
  if (active.length !== 39) fail(`expected 39 active mappings, got ${active.length}`);
  const expectedNumbers = Array.from({ length: 39 }, (_, index) => String(index + 1).padStart(2, '0'));
  if (active.map((item) => item.number).join() !== expectedNumbers.join()) fail('active numbers must be 01 through 39 in authored order');
  if (new Set(active.map((item) => item.number)).size !== 39) fail('active numbers must be unique');
  for (const collection of input.collections) {
  if (collection.prints.length < 1) fail(`${collection.slug} must contain at least 1 print`);
  }
  for (const item of retired) {
  if (!active.some((candidate) => candidate.productId === item.duplicateOf)) fail(`${item.productId} duplicateOf must be active`);
  }
}

validatePrintCuration(input);

const active: PrintCuration[] = input.collections.flatMap((collection) => collection.prints.map((item) => ({ ...item, collectionSlug: collection.slug })));
const retired: PrintCuration[] = input.retired.map((item) => ({ ...item }));
const all = [...active, ...retired];

export const PRINT_CURATION = all;
export const ACTIVE_PRINT_CURATION = active;
export const RETIRED_PRINT_CURATION = retired;
export const PRINT_COLLECTION_DEFINITIONS: PrintCollectionDefinition[] = input.collections.map(({ slug, name, prints }) => ({
  slug,
  name,
  designIds: prints.map(({ productId }) => productId),
  prints: active.filter((item) => item.collectionSlug === slug),
}));

export function curationForProduct(id: string): PrintCuration | undefined {
  return ACTIVE_PRINT_CURATION.find((item) => item.productId === id);
}

/** Customer-facing name, numbered independently in each authored collection.
 * Resolve by ID so code and database catalogues use the same names.
 */
export function printDisplayName(
  design: { id: string; num: string },
  fallback = 'Print',
  definitions: PrintCollectionDefinition[] = PRINT_COLLECTION_DEFINITIONS,
): string {
  for (const collection of definitions) {
    const index = collection.designIds.indexOf(design.id);
    if (index !== -1) return `${collection.name} ${String(index + 1).padStart(2, '0')}`;
  }
  return `${fallback} Nº ${design.num}`;
}

export function catalogStatusForPrint(id: string): 'active' | 'archived' {
  if (curationForProduct(id)) return 'active';
  if (RETIRED_PRINT_CURATION.some((item) => item.productId === id)) return 'archived';
  throw new Error(`Unknown print ID: ${id}`);
}
