/**
 * LOCAL-ONLY admin product display helpers. Resolves an order line's stable
 * `product_id` to a human label + thumbnail using the storefront registry
 * (`registryProductById` — admin labels are code-derived and stay on the
 * synchronous registry). Unknown ids (e.g. retired smoke-test pieces still
 * referenced by old orders) degrade to showing the raw id.
 */
import { dropLabelSuffix, registryProductById } from '@/lib/products';
import { formatLegacyPrintVariant, isLegacyPrintId, legacyPrintName } from '@/lib/legacy-print-lines';
import { smallest } from '@/lib/images';
import type { CategorySlug } from '@/lib/types';

/** Internal PL singular labels per family (admin is Polish-only, no i18n machinery). */
export const CATEGORY_LABEL: Record<CategorySlug, string> = {
  kubki: 'Kubek',
  wazony: 'Wazon mały',
  'wazony-srednie': 'Wazon średni',
  'wazony-duze': 'Wazon duży',
  talerzyki: 'Talerzyk',
  'talerze-srednie': 'Talerz średni',
  'talerze-duze': 'Talerz duży',
  'duze-michy': 'Micha duża',
  'miski-falowane': 'Miska falowana',
  'talerze-owalne': 'Talerz owalny',
  'talerze-male': 'Talerz mały',
};

export type ProductRef = {
  id: string;
  label: string;
  category: string;
  image: string | null;
  known: boolean;
};

export function productRef(productId: string, variant?: unknown): ProductRef {
  const p = registryProductById(productId);
  if (p) {
    return {
      id: p.id,
      label: `${CATEGORY_LABEL[p.category]} Nº${p.num}${dropLabelSuffix(p)}`,
      category: p.category,
      image: smallest(p.image),
      known: true,
    };
  }
  // Historical fine-art print line (retired shop, 2026-11): frozen name +
  // stored variant, no thumbnail (the print images left with the shop).
  if (isLegacyPrintId(productId)) {
    const variantText = formatLegacyPrintVariant(variant, 'pl');
    return {
      id: productId,
      label: `${legacyPrintName(productId, 'pl')}${variantText ? ` · ${variantText}` : ''}`,
      category: 'fine-art-prints',
      image: null,
      known: true,
    };
  }
  return { id: productId, label: productId, category: '—', image: null, known: false };
}
