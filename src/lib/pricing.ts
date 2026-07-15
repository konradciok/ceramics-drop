/* PLN, EUR, GBP prices with helpers. Currency is chosen per request from the
 * `currency_pref` cookie (see currency.ts), not from the locale: `pl` → PLN,
 * everyone else defaults to EUR and can switch to GBP. */
import type { CategorySlug } from './types';
import type { Currency } from './currency';

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
  'fine-art-prints': 0, // ponytail: prints use print-pricing.ts, not this map
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

/** Major currency units → minor units. PLN/EUR/GBP are all 100-minor-unit
 * currencies, so grosze/euro-cents/pence are all `Math.round(units × 100)`. */
export function toMinor(units: number): number {
  return Math.round(units * 100);
}

/** Shipping cost (grosze) for the chosen delivery method. */
export function shippingGrosze(method: DeliveryMethod): number {
  return toMinor(SHIPPING_PLN[method]);
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
  'fine-art-prints': 0, // ponytail: prints use print-pricing.ts, not this map
};

/* Paczkomat (20 zł ≈ 4.76 €) rounds to 5 €.
 * Kurier (30 zł ≈ 7.14 €) is set to 10 € — deliberate round-number buffer. */
export const SHIPPING_EUR: Record<DeliveryMethod, number> = {
  paczkomat: 5,
  kurier: 10,
  odbior: 0,
};

/**
 * Fixed GBP prices per category (whole pounds). Approximate rate: 1 GBP ≈ 1.18 EUR (June 2026).
 * Review with the artisan whenever EUR prices change significantly.
 */
export const PRICE_GBP: Record<CategorySlug, number> = {
  kubki: 22,
  wazony: 50,
  'wazony-srednie': 58,
  'wazony-duze': 75,
  talerzyki: 15,
  'talerze-srednie': 24,
  'talerze-duze': 32,
  'duze-michy': 75,
  'miski-falowane': 42,
  'fine-art-prints': 0, // ponytail: prints use print-pricing.ts, not this map
};

export const SHIPPING_GBP: Record<DeliveryMethod, number> = {
  paczkomat: 5,
  kurier: 12,
  odbior: 0,
};

/** Shipping cost in pence for the chosen delivery method. */
export function shippingGBPPence(method: DeliveryMethod): number {
  return toMinor(SHIPPING_GBP[method]);
}

/** Sum item amounts (pence) + shipping for the chosen method. */
export function orderAmountGBPPence(itemPence: number[], method: DeliveryMethod): number {
  return itemPence.reduce((s, p) => s + p, 0) + shippingGBPPence(method);
}

/**
 * Display price in a locale's *default* currency (no cookie): `pl` → PLN,
 * everyone else → EUR. Use this for cookie-independent surfaces (SEO structured
 * data, product feeds). For cookie-aware on-page/checkout prices use
 * `priceOfCurrency` with the currency resolved from `getCurrency`.
 */
export function priceOf(product: { category: CategorySlug; price: number }, locale: string): number {
  if (locale === 'pl') return product.price;
  return PRICE_EUR[product.category];
}

/** Display price for a product in an explicit currency. */
export function priceOfCurrency(
  product: { category: CategorySlug; price: number },
  currency: Currency,
): number {
  switch (currency) {
    case 'pln':
      return product.price;
    case 'gbp':
      return PRICE_GBP[product.category];
    case 'eur':
    default:
      return PRICE_EUR[product.category];
  }
}

/**
 * Display shipping price (major units) for a delivery method in a display
 * currency. Unknown currencies hit the EUR default.
 */
export function shippingOfCurrency(currency: Currency, method: DeliveryMethod): number {
  switch (currency) {
    case 'pln':
      return SHIPPING_PLN[method];
    case 'gbp':
      return SHIPPING_GBP[method];
    case 'eur':
    default:
      return SHIPPING_EUR[method];
  }
}

/** Shipping cost in euro-cents for the chosen delivery method. */
export function shippingEuroCents(method: DeliveryMethod): number {
  return toMinor(SHIPPING_EUR[method]);
}

/** Sum item amounts (euro-cents) + shipping for the chosen method. */
export function orderAmountEuroCents(itemCents: number[], method: DeliveryMethod): number {
  return itemCents.reduce((s, c) => s + c, 0) + shippingEuroCents(method);
}
