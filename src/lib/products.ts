/* ============================================================
   Product catalogue — registry + accessors
   ------------------------------------------------------------
   The CATEGORIES registry below is the structural site map of the
   nine product families (slug, price, measure, count). It drives
   routing, navigation and the collection pages.

   getProducts() returns the full Product[] built in two passes:
     1. buildBase() generates the original pieces with STABLE ids
        (id never changes for a physical piece — it is the key used
        by piece_state / orders in the DB).
     2. applyInventoryReview() applies the artist's June inventory
        review as a declarative diff (removals, recategorisations,
        gallery merges), then renumbers the DISPLAY number (num) and
        noteIndex per category. Stable ids survive; only num/category
        change. This protects sold/ordered pieces from renumbering.
   ============================================================ */
import type { Category, CategorySlug, Product } from './types';
import { PRICE_PLN } from './pricing';

export const CATEGORIES: Record<CategorySlug, Category> = {
  kubki: { slug: 'kubki', nameKey: 'nav.kubki', singularKey: 'mug', price: PRICE_PLN['kubki'], measure: '8 × 8 × 10 cm', count: 28 },
  wazony: { slug: 'wazony', nameKey: 'nav.wazony', singularKey: 'vase', price: PRICE_PLN['wazony'], measure: '19,5 × 15 × 15 cm', count: 9 },
  'wazony-srednie': { slug: 'wazony-srednie', nameKey: 'nav.wazonySrednie', singularKey: 'midvase', price: PRICE_PLN['wazony-srednie'], measure: '25 × 16 × 16 cm', count: 5 },
  'wazony-duze': { slug: 'wazony-duze', nameKey: 'nav.wazonyDuze', singularKey: 'bigvase', price: PRICE_PLN['wazony-duze'], measure: '28 × 19 × 19 cm', count: 4 },
  talerzyki: { slug: 'talerzyki', nameKey: 'nav.talerzyki', singularKey: 'dish', price: PRICE_PLN['talerzyki'], measure: '12 × 12 × 3 cm', count: 14 },
  'talerze-srednie': { slug: 'talerze-srednie', nameKey: 'nav.talerzeSrednie', singularKey: 'medplate', price: PRICE_PLN['talerze-srednie'], measure: '⌀ 18 cm', count: 18 },
  'talerze-duze': { slug: 'talerze-duze', nameKey: 'nav.talerzeDuze', singularKey: 'plate', price: PRICE_PLN['talerze-duze'], measure: '⌀ 24 cm', count: 9 },
  'duze-michy': { slug: 'duze-michy', nameKey: 'nav.duzeMichy', singularKey: 'largebowl', price: PRICE_PLN['duze-michy'], measure: '24 × 24 × 11 cm', count: 6 },
  'miski-falowane': { slug: 'miski-falowane', nameKey: 'nav.miskiFalowane', singularKey: 'wavybowl', price: PRICE_PLN['miski-falowane'], measure: '18 × 18 × 9 cm', count: 10 },
};

/** Ordered list of category slugs (nav / footer / shop switcher order). */
export const CATEGORY_ORDER: CategorySlug[] = [
  'kubki',
  'wazony',
  'wazony-srednie',
  'wazony-duze',
  'talerzyki',
  'talerze-srednie',
  'talerze-duze',
  'duze-michy',
  'miski-falowane',
];

export function getCategory(slug: CategorySlug): Category {
  return CATEGORIES[slug];
}


const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

type Spec = {
  slug: CategorySlug;
  prefix: string;
  imageBase: string;
  /** Image file numbers, in original order (skips reflect missing files). */
  files: number[];
};

/* Original generation specs. These define the STABLE id of every physical
   piece: id = prefix + pad(positionInFiles). Image stem is imageBase-file.
   Never reorder/edit these to "fix" the catalogue — that would renumber
   stable ids. Catalogue changes go through INVENTORY_REVIEW below. */
const SPECS: Spec[] = [
  { slug: 'kubki', prefix: 'k', imageBase: 'kubek', files: range(1, 26) },
  { slug: 'wazony', prefix: 'v', imageBase: 'waza-mala', files: range(1, 9) },
  { slug: 'wazony-duze', prefix: 'd', imageBase: 'waza-duza', files: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { slug: 'talerzyki', prefix: 't', imageBase: 'talerz-maly', files: range(1, 31) },
  { slug: 'talerze-srednie', prefix: 's', imageBase: 'sredni-talerz', files: [17, 18] },
  { slug: 'talerze-duze', prefix: 'p', imageBase: 'talerz-duzy', files: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] },
  { slug: 'duze-michy', prefix: 'b', imageBase: 'duza-micha', files: range(1, 7) },
  { slug: 'miski-falowane', prefix: 'w', imageBase: 'miski-falowane', files: range(1, 17) },
  { slug: 'kubki', prefix: 'c', imageBase: 'kubek-kolejny-nr', files: [1, 2, 3, 4] },
  { slug: 'kubki', prefix: 'x', imageBase: 'kubek', files: [1] },  // smoke-test piece — remove after prod payment verified
  { slug: 'wazony-srednie', prefix: 'u', imageBase: 'sredni-wazon', files: [234] },
  { slug: 'wazony-duze', prefix: 'g', imageBase: 'duza-waza', files: [122] },
  { slug: 'duze-michy', prefix: 'h', imageBase: 'duza-miska', files: [23] },
];

/** Base piece: stable id + image, before the inventory review diff. */
type BasePiece = { id: string; category: CategorySlug; image: string };

function buildBase(): BasePiece[] {
  const base: BasePiece[] = [];
  for (const spec of SPECS) {
    spec.files.forEach((file, i) => {
      base.push({
        id: `${spec.prefix}${pad(i + 1)}`,
        category: spec.slug,
        image: `/uploads/${spec.imageBase}-${file}.webp`,
      });
    });
  }
  return base;
}

/* ------------------------------------------------------------------
   Inventory review — June drop (notatki ze spotkania z artystką).
   Expressed as a diff over the stable base so that ids never shift.
   ------------------------------------------------------------------ */

/** Pieces removed from sale entirely (drop from catalogue + piece_state). */
const REMOVED = new Set<string>([
  'k15', 'k16',                          // kubki
  'x01',                                 // smoke-test mug (prod payment verified)
  'v08', 'd04', 'd08',                   // wazy: out / duplicate
  't03',                                 // talerzyki
  'p04', 'p06', 'p11',                   // talerze-duze
  'b05', 'b06',                          // duże misy (galeria później)
  'w01', 'w02', 'w04', 'w10',            // miski falowane: out
  'w11', 'w13', 'w16',                   // miski falowane: scalone jako 2. zdjęcie
]);

/** Pieces moved to a different family (keep stable id, change category). */
const RECATEGORISE: Record<string, CategorySlug> = {
  // dawne "Duże wazony" rozbite na średnie + duże
  d01: 'wazony-srednie', d02: 'wazony-srednie', d03: 'wazony-srednie', d05: 'wazony-srednie',
  // swap między poziomami
  d10: 'wazony',         // duże Nº10 → małe
  // nowe talerzyki średnie — t16–t31 przeniesione do nowej kategorii
  t16: 'talerze-srednie', t17: 'talerze-srednie', t18: 'talerze-srednie', t19: 'talerze-srednie',
  t20: 'talerze-srednie', t21: 'talerze-srednie', t22: 'talerze-srednie', t23: 'talerze-srednie',
  t24: 'talerze-srednie', t25: 'talerze-srednie', t26: 'talerze-srednie', t27: 'talerze-srednie',
  t28: 'talerze-srednie', t29: 'talerze-srednie', t30: 'talerze-srednie', t31: 'talerze-srednie',
};

/** Display order overrides: pieces appended to the END of a family, in order. */
const APPEND_ORDER: Partial<Record<CategorySlug, string[]>> = {
  wazony: ['d10'],
};

/** Gallery merges: target id gets these extra image stems (second photos). */
const GALLERY_MERGE: Record<string, string[]> = {
  w12: ['/uploads/miski-falowane-11.webp'],
  w14: ['/uploads/miski-falowane-13.webp'],
  w15: ['/uploads/miski-falowane-16.webp'],
};

/** Per-product price overrides in PLN (used for test/one-off pieces). */
const PRICE_OVERRIDE: Record<string, number> = {};

/** Per-product measure overrides. */
const MEASURE_OVERRIDE: Record<string, string> = {};

function buildProducts(): Product[] {
  const base = buildBase().filter((p) => !REMOVED.has(p.id));

  // Apply recategorisation.
  for (const p of base) {
    const next = RECATEGORISE[p.id];
    if (next) p.category = next;
  }

  // Group per family, preserving base order, then appended movers.
  const byCat = CATEGORY_ORDER.reduce(
    (acc, slug) => {
      acc[slug] = [];
      return acc;
    },
    {} as Record<CategorySlug, BasePiece[]>,
  );
  for (const p of base) {
    if (!APPEND_ORDER[p.category]?.includes(p.id)) byCat[p.category].push(p);
  }
  for (const slug of CATEGORY_ORDER) {
    for (const id of APPEND_ORDER[slug] ?? []) {
      const piece = base.find((p) => p.id === id);
      if (piece) byCat[slug].push(piece);
    }
  }

  // Materialise: assign sequential display num + noteIndex, attach gallery.
  const products: Product[] = [];
  for (const slug of CATEGORY_ORDER) {
    const cat = CATEGORIES[slug];
    byCat[slug].forEach((p, i) => {
      products.push({
        id: p.id,
        category: slug,
        num: pad(i + 1),
        image: p.image,
        ...(GALLERY_MERGE[p.id] ? { gallery: GALLERY_MERGE[p.id] } : {}),
        price: PRICE_OVERRIDE[p.id] ?? cat.price,
        measure: MEASURE_OVERRIDE[p.id] ?? cat.measure,
        sold: false,
        noteIndex: i,
      });
    });
  }
  return products;
}

/* The registry is static build-time data, so compute it once at module
   load and reuse it; lookups read from the prebuilt id map / groupings. */
const PRODUCTS = buildProducts();
const PRODUCT_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));
const PRODUCTS_BY_CATEGORY = CATEGORY_ORDER.reduce(
  (acc, slug) => {
    acc[slug] = PRODUCTS.filter((p) => p.category === slug);
    return acc;
  },
  {} as Record<CategorySlug, Product[]>,
);

/**
 * Returns every product across the nine categories, each with image
 * path, optional gallery, sold flag, price, measure, and display index.
 */
export function getProducts(): Product[] {
  return PRODUCTS;
}

export function getProductsByCategory(slug: CategorySlug): Product[] {
  return PRODUCTS_BY_CATEGORY[slug];
}

export function getProductById(id: string): Product | undefined {
  return PRODUCT_BY_ID.get(id);
}

/** Resolve known products by id without filtering sold pieces. */
export function resolveKnownProducts(ids: string[]): Product[] {
  return ids
    .map((id) => PRODUCT_BY_ID.get(id))
    .filter((p): p is Product => p !== undefined);
}

/**
 * Resolves a list of cart ids to the products that may actually be bought —
 * dropping unknown ids and sold (one-of-a-kind, already-gone) pieces. Used by
 * the cart surfaces so stale localStorage can never reintroduce sold inventory.
 */
export function resolveCartProducts(ids: string[]): Product[] {
  return resolveKnownProducts(ids).filter((p) => !p.sold);
}
