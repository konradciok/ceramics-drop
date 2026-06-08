/* ============================================================
   Product catalogue — registry + accessors
   ------------------------------------------------------------
   The CATEGORIES registry below is the structural site map of the
   seven product families (slug, price, measure, count). It drives
   routing, navigation and the collection pages.

   getProducts() returns the full 96-piece Product[] built from SPECS:
   image paths (mapped from upload filenames), sold flags, and per-piece
   metadata (id, num, price, measure, noteIndex). Category descriptions
   are wired through the i18n message catalogs.
   ============================================================ */
import type { Category, CategorySlug, Product } from './types';
import { PRICE_PLN } from './pricing';

export const CATEGORIES: Record<CategorySlug, Category> = {
  kubki: { slug: 'kubki', nameKey: 'nav.kubki', singularKey: 'mug', price: PRICE_PLN['kubki'], measure: '9 × 9 cm · 300 ml', count: 26 },
  wazony: { slug: 'wazony', nameKey: 'nav.wazony', singularKey: 'vase', price: PRICE_PLN['wazony'], measure: '18 × 16 cm', count: 9 },
  'wazony-duze': { slug: 'wazony-duze', nameKey: 'nav.wazonyDuze', singularKey: 'bigvase', price: PRICE_PLN['wazony-duze'], measure: '24 × 20 cm', count: 10 },
  talerzyki: { slug: 'talerzyki', nameKey: 'nav.talerzyki', singularKey: 'dish', price: PRICE_PLN['talerzyki'], measure: '⌀ 12 cm', count: 15 },
  'talerze-duze': { slug: 'talerze-duze', nameKey: 'nav.talerzeDuze', singularKey: 'plate', price: PRICE_PLN['talerze-duze'], measure: '⌀ 28 cm', count: 12 },
  'duze-michy': { slug: 'duze-michy', nameKey: 'nav.duzeMichy', singularKey: 'largebowl', price: PRICE_PLN['duze-michy'], measure: '⌀ 26 × 14 cm', count: 7 },
  'miski-falowane': { slug: 'miski-falowane', nameKey: 'nav.miskiFalowane', singularKey: 'wavybowl', price: PRICE_PLN['miski-falowane'], measure: '⌀ 16 × 9 cm', count: 17 },
};

/** Ordered list of category slugs (nav / footer / shop switcher order). */
export const CATEGORY_ORDER: CategorySlug[] = [
  'kubki',
  'wazony',
  'wazony-duze',
  'talerzyki',
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
  /** Image file numbers, in display order (skips reflect missing files). */
  files: number[];
};

const SPECS: Spec[] = [
  { slug: 'kubki', prefix: 'k', imageBase: 'kubek', files: range(1, 26) },
  { slug: 'wazony', prefix: 'v', imageBase: 'waza-mala', files: range(1, 9) },
  { slug: 'wazony-duze', prefix: 'd', imageBase: 'waza-duza', files: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { slug: 'talerzyki', prefix: 't', imageBase: 'talerz-maly', files: range(1, 15) },
  { slug: 'talerze-duze', prefix: 'p', imageBase: 'talerz-duzy', files: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] },
  { slug: 'duze-michy', prefix: 'b', imageBase: 'duza-micha', files: range(1, 7) },
  { slug: 'miski-falowane', prefix: 'w', imageBase: 'miski-falowane', files: range(1, 17) },
];

function buildProducts(): Product[] {
  const products: Product[] = [];
  for (const spec of SPECS) {
    const cat = CATEGORIES[spec.slug];
    spec.files.forEach((file, i) => {
      const num = pad(i + 1);
      const id = `${spec.prefix}${num}`;
      products.push({
        id,
        category: spec.slug,
        num,
        image: `/uploads/${spec.imageBase}-${file}.webp`,
        price: cat.price,
        measure: cat.measure,
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
 * Returns every product — all 96 pieces across the seven categories,
 * each with image path, sold flag, price, measure, and display index.
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
