/* ============================================================
   Account item labels + money/date display helpers (server-side).
   Names resolve through the code registry like the cart and invoices do;
   unknown ids (retired pieces on old orders) degrade to the raw id.
   ============================================================ */
import { CATEGORIES, registryProductById } from '@/lib/products';
import { registryPrintById } from '@/lib/prints';
import { variantLabel } from '@/lib/print-cart';
import type { PrintVariantSelection } from '@/lib/types';
import type { AccountOrderItem } from './orders';

export type AccountItemLabel = {
  key: string;
  name: string;
  /** Print variant summary (size · frame · mount), null for ceramics. */
  detail: string | null;
};

type Translate = (key: string) => string;

const PRINT_SIZES = new Set(['30x40', '50x70', '70x100']);

function printDetail(variant: unknown, locale: string): string | null {
  if (typeof variant !== 'object' || variant === null) return null;
  const v = variant as Record<string, unknown>;
  if (typeof v.size !== 'string' || !PRINT_SIZES.has(v.size) || typeof v.framed !== 'boolean') {
    return null;
  }
  const sel: PrintVariantSelection = {
    size: v.size as PrintVariantSelection['size'],
    framed: v.framed,
    mount: v.mount === true,
    frameColour: (typeof v.frameColour === 'string'
      ? v.frameColour
      : 'none') as PrintVariantSelection['frameColour'],
  };
  return variantLabel(sel, locale);
}

/** Localised display name for one order line (ceramic piece or print variant). */
export function accountItemLabel(item: AccountOrderItem, t: Translate, locale: string): AccountItemLabel {
  if (item.variant != null) {
    const design = registryPrintById(item.product_id);
    return {
      key: `${item.product_id}-${JSON.stringify(item.variant)}`,
      name: design ? `${t('product.print')} Nº ${design.num}` : item.product_id,
      detail: printDetail(item.variant, locale),
    };
  }
  const product = registryProductById(item.product_id);
  if (!product) return { key: item.product_id, name: item.product_id, detail: null };
  const singular = CATEGORIES[product.category].singularKey;
  return {
    key: item.product_id,
    name: `${t(`product.${singular}`)} Nº ${product.num}`,
    detail: null,
  };
}

const CURRENCY_CODE: Record<string, string> = { pln: 'PLN', eur: 'EUR', gbp: 'GBP', usd: 'USD', cad: 'CAD' };

/** Minor-unit order amount → localized currency string (e.g. 8900 pln → "89,00 zł"). */
export function formatOrderAmount(minorUnits: number, currency: string, locale: string): string {
  const code = CURRENCY_CODE[currency] ?? currency.toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(
      (minorUnits ?? 0) / 100,
    );
  } catch {
    return `${((minorUnits ?? 0) / 100).toFixed(2)} ${code}`;
  }
}

/** Order date in the page locale (e.g. "23 lipca 2026"). */
export function formatOrderDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}
