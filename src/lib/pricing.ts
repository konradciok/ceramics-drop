/* PLN prices (zloty) and grosze helpers. PLN is the charge currency. */
import type { CategorySlug } from './types';

export const PRICE_PLN: Record<CategorySlug, number> = {
  kubki: 90,
  wazony: 210,
  'wazony-duze': 395,
  talerzyki: 105,
  'talerze-duze': 270,
  'duze-michy': 315,
  'miski-falowane': 155,
};

export const SHIPPING_PLN = 75;

export type ShipMethod = 'kurier' | 'odbior';

/** Zloty (integer) → grosze. Prices have no fractional zloty, so this is ×100. */
export function toGrosze(zloty: number): number {
  return Math.round(zloty * 100);
}

/** Sum item amounts (grosze) plus shipping for the chosen method. */
export function orderAmountGrosze(itemGrosze: number[], method: ShipMethod): number {
  const items = itemGrosze.reduce((s, g) => s + g, 0);
  const shipping = method === 'odbior' ? 0 : toGrosze(SHIPPING_PLN);
  return items + shipping;
}
