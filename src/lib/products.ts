/* ============================================================
   Product catalogue — registry + accessors (SCAFFOLD)
   ------------------------------------------------------------
   The CATEGORIES registry below is the structural site map of the
   seven product families (slug, price, measure, count). It drives
   routing, navigation and the collection pages.

   The actual per-piece data (image paths, sold flags) and the
   trilingual descriptions live in the *content phase*: implement
   `getProducts()` to build the `Product[]` (see design/assets/shop.js
   for the reference generation), and wire descriptions through the
   i18n message catalogs.
   ============================================================ */
import type { Category, CategorySlug, Product } from './types';

export const CATEGORIES: Record<CategorySlug, Category> = {
  kubki: { slug: 'kubki', nameKey: 'nav.kubki', singularKey: 'mug', price: 22, measure: '9 × 9 cm · 300 ml', count: 22 },
  wazony: { slug: 'wazony', nameKey: 'nav.wazony', singularKey: 'vase', price: 50, measure: '18 × 16 cm', count: 8 },
  'wazony-duze': { slug: 'wazony-duze', nameKey: 'nav.wazonyDuze', singularKey: 'bigvase', price: 95, measure: '24 × 20 cm', count: 9 },
  talerzyki: { slug: 'talerzyki', nameKey: 'nav.talerzyki', singularKey: 'dish', price: 25, measure: '⌀ 12 cm', count: 15 },
  'talerze-duze': { slug: 'talerze-duze', nameKey: 'nav.talerzeDuze', singularKey: 'plate', price: 65, measure: '⌀ 28 cm', count: 12 },
  'duze-michy': { slug: 'duze-michy', nameKey: 'nav.duzeMichy', singularKey: 'largebowl', price: 75, measure: '⌀ 26 × 14 cm', count: 6 },
  'miski-falowane': { slug: 'miski-falowane', nameKey: 'nav.miskiFalowane', singularKey: 'wavybowl', price: 38, measure: '⌀ 16 × 9 cm', count: 16 },
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

const SOLD = new Set(['k04', 'k11', 'k19', 'v02', 'v06']);

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
  { slug: 'kubki', prefix: 'k', imageBase: 'kubek', files: range(1, 22) },
  { slug: 'wazony', prefix: 'v', imageBase: 'waza-mala', files: range(1, 8) },
  { slug: 'wazony-duze', prefix: 'd', imageBase: 'waza-duza', files: [1, 3, 4, 5, 6, 7, 8, 9, 10] },
  { slug: 'talerzyki', prefix: 't', imageBase: 'talerz-maly', files: range(1, 15) },
  { slug: 'talerze-duze', prefix: 'p', imageBase: 'talerz-duzy', files: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] },
  { slug: 'duze-michy', prefix: 'b', imageBase: 'duza-micha', files: range(1, 6) },
  { slug: 'miski-falowane', prefix: 'w', imageBase: 'miski-falowane', files: range(1, 16) },
];

/**
 * Returns every product. Content phase: build the full 88-piece list
 * (image paths, sold flags) here — see design/assets/shop.js.
 */
export function getProducts(): Product[] {
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
        image: `/uploads/${spec.imageBase}-${file}.png`,
        price: cat.price,
        measure: cat.measure,
        sold: SOLD.has(id),
        noteIndex: i,
      });
    });
  }
  return products;
}

export function getProductsByCategory(slug: CategorySlug): Product[] {
  return getProducts().filter((p) => p.category === slug);
}

export function getProductById(id: string): Product | undefined {
  return getProducts().find((p) => p.id === id);
}
