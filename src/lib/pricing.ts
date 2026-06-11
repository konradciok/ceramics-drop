/* PLN and EUR prices with helpers. PL locale → PLN; en/es locales → EUR. */
import type { CategorySlug } from './types';

export const PRICE_PLN: Record<CategorySlug, number> = {
  kubki: 95,
  wazony: 239,
  'wazony-srednie': 289,
  'wazony-duze': 379,
  talerzyki: 69,
  'talerze-srednie': 119,
  'talerze-duze': 160,
  'duze-michy': 345,
  'miski-falowane': 195,
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

/**
 * Fixed EUR prices per category (whole euros). Approximate rate: 1 EUR ≈ 4.20 PLN (June 2026).
 * Review with the artisan whenever PLN prices change significantly.
 */
export const PRICE_EUR: Record<CategorySlug, number> = {
  kubki: 25,
  wazony: 58,
  'wazony-srednie': 68,
  'wazony-duze': 88,
  talerzyki: 18,
  'talerze-srednie': 28,
  'talerze-duze': 38,
  'duze-michy': 88,
  'miski-falowane': 48,
};

/* Paczkomat (20 zł ≈ 4.76 €) rounds to 5 €.
 * Kurier (30 zł ≈ 7.14 €) is set to 10 € — deliberate round-number buffer. */
export const SHIPPING_EUR: Record<DeliveryMethod, number> = {
  paczkomat: 5,
  kurier: 10,
  odbior: 0,
};

/** Returns the display price for a product in the correct currency for the given locale. */
export function priceOf(product: { category: CategorySlug; price: number }, locale: string): number {
  return locale !== 'pl' ? PRICE_EUR[product.category] : product.price;
}

/** Euros (integer) → euro-cents. Same ×100 math as toGrosze. */
export function toEuroCents(euros: number): number {
  return Math.round(euros * 100);
}

/** Shipping cost in euro-cents for the chosen delivery method. */
export function shippingEuroCents(method: DeliveryMethod): number {
  return toEuroCents(SHIPPING_EUR[method]);
}

/** Sum item amounts (euro-cents) + shipping for the chosen method. */
export function orderAmountEuroCents(itemCents: number[], method: DeliveryMethod): number {
  return itemCents.reduce((s, c) => s + c, 0) + shippingEuroCents(method);
}
