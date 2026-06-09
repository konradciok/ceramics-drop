/* PLN prices (zloty) and grosze helpers. PLN is the charge currency. */
import type { CategorySlug } from './types';

export const PRICE_PLN: Record<CategorySlug, number> = {
  kubki: 90,
  wazony: 210,
  // TODO(artystka): potwierdzić cenę "Średnich wazonów" — placeholder między małymi (210) a dużymi (395).
  'wazony-srednie': 300,
  'wazony-duze': 395,
  talerzyki: 105,
  'talerze-duze': 270,
  'duze-michy': 315,
  'miski-falowane': 155,
};

/** Delivery methods — InPost is the sole carrier; `odbior` is free Warsaw pickup. */
export type DeliveryMethod = 'paczkomat' | 'kurier' | 'odbior';

/**
 * Customer-facing delivery price (zloty) per method. Placeholder figures —
 * confirm against the studio's InPost rates before launch.
 */
export const SHIPPING_PLN: Record<DeliveryMethod, number> = {
  paczkomat: 20,
  kurier: 30,
  odbior: 0,
};

/** Zloty (integer) → grosze. Prices have no fractional zloty, so this is ×100. */
export function toGrosze(zloty: number): number {
  return Math.round(zloty * 100);
}

/** Shipping cost (grosze) for the chosen delivery method. */
export function shippingGrosze(method: DeliveryMethod): number {
  return toGrosze(SHIPPING_PLN[method]);
}

/** Sum item amounts (grosze) plus shipping for the chosen method. */
export function orderAmountGrosze(itemGrosze: number[], method: DeliveryMethod): number {
  const items = itemGrosze.reduce((s, g) => s + g, 0);
  return items + shippingGrosze(method);
}
