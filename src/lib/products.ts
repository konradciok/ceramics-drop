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
  kubki: { slug: 'kubki', nameKey: 'nav.kubki', price: 22, measure: '9 × 9 cm · 300 ml', count: 22 },
  wazony: { slug: 'wazony', nameKey: 'nav.wazony', price: 50, measure: '18 × 16 cm', count: 8 },
  'wazony-duze': { slug: 'wazony-duze', nameKey: 'nav.wazonyDuze', price: 95, measure: '24 × 20 cm', count: 9 },
  talerzyki: { slug: 'talerzyki', nameKey: 'nav.talerzyki', price: 25, measure: '⌀ 12 cm', count: 15 },
  'talerze-duze': { slug: 'talerze-duze', nameKey: 'nav.talerzeDuze', price: 65, measure: '⌀ 28 cm', count: 12 },
  'duze-michy': { slug: 'duze-michy', nameKey: 'nav.duzeMichy', price: 75, measure: '⌀ 26 × 14 cm', count: 6 },
  'miski-falowane': { slug: 'miski-falowane', nameKey: 'nav.miskiFalowane', price: 38, measure: '⌀ 16 × 9 cm', count: 16 },
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

/**
 * Returns every product. Content phase: build the full 88-piece list
 * (image paths, sold flags) here — see design/assets/shop.js.
 */
export function getProducts(): Product[] {
  return [];
}

export function getProductsByCategory(slug: CategorySlug): Product[] {
  return getProducts().filter((p) => p.category === slug);
}

export function getProductById(id: string): Product | undefined {
  return getProducts().find((p) => p.id === id);
}
