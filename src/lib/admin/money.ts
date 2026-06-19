/**
 * LOCAL-ONLY admin money formatting. Order money columns are stored in MINOR
 * units (grosze / euro-cents); render them in major units with the right
 * symbol. Distinct from the storefront `pln()`/`eur()` which take whole units.
 */
export type OrderCurrency = 'pln' | 'eur';

const FORMATTERS: Record<OrderCurrency, Intl.NumberFormat> = {
  pln: new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }),
  eur: new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }),
};

/** "8900" + "pln" → "89,00 zł". Falls back to PLN for unknown currency. */
export function formatMoney(minorUnits: number, currency: string): string {
  const c: OrderCurrency = currency === 'eur' ? 'eur' : 'pln';
  return FORMATTERS[c].format((minorUnits ?? 0) / 100);
}
