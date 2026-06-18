/**
 * LOCAL-ONLY admin product display helpers. Resolves an order line's stable
 * `product_id` to a human label + thumbnail using the storefront registry
 * (`getProductById`). Unknown ids (e.g. retired smoke-test pieces still
 * referenced by old orders) degrade to showing the raw id.
 */
import { getProductById } from '@/lib/products';
import { smallest } from '@/lib/images';
import type { CategorySlug } from '@/lib/types';

/** Internal PL singular labels per family (admin is Polish-only, no i18n machinery). */
const CATEGORY_LABEL: Record<CategorySlug, string> = {
  kubki: 'Kubek',
  wazony: 'Wazon mały',
  'wazony-srednie': 'Wazon średni',
  'wazony-duze': 'Wazon duży',
  talerzyki: 'Talerzyk',
  'talerze-srednie': 'Talerz średni',
  'talerze-duze': 'Talerz duży',
  'duze-michy': 'Micha duża',
  'miski-falowane': 'Miska falowana',
};

export type ProductRef = {
  id: string;
  label: string;
  category: string;
  image: string | null;
  known: boolean;
};

export function productRef(productId: string): ProductRef {
  const p = getProductById(productId);
  if (!p) {
    return { id: productId, label: productId, category: '—', image: null, known: false };
  }
  return {
    id: p.id,
    label: `${CATEGORY_LABEL[p.category]} Nº${p.num}`,
    category: p.category,
    image: smallest(p.image),
    known: true,
  };
}
