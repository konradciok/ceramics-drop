import source from '../../config/print-catalog-curation.json';

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
  if (collection.prints.length < 4 || collection.prints.length > 5) fail(`${collection.slug} must contain 4 or 5 prints`);
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

export function catalogStatusForPrint(id: string): 'active' | 'archived' {
  if (curationForProduct(id)) return 'active';
  if (RETIRED_PRINT_CURATION.some((item) => item.productId === id)) return 'archived';
  throw new Error(`Unknown print ID: ${id}`);
}
