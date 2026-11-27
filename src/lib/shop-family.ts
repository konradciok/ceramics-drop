/* ============================================================
   Family filter for /sklep — the `?rodzina=<slug>` query parameter
   behind the chip row. Pure helpers so the page, the server
   component and the unit tests share one definition.
   ============================================================ */
import { VISIBLE_CATEGORY_ORDER } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';

/** Query parameter that narrows the shop to one ceramic family. */
export const SHOP_FAMILY_PARAM = 'rodzina';

/** The single no-JS chip link: `/sklep?rodzina=<slug>`. */
export function shopFamilyHref(slug: CategorySlug): string {
  return `/sklep?${SHOP_FAMILY_PARAM}=${slug}`;
}

/**
 * Validates the raw `rodzina` query value. Only a slug in the visible family
 * set narrows the shop — unknown, empty, and hidden family values are ignored.
 * When the parameter repeats, only the first value is read.
 */
export function parseFamilyParam(
  raw: string | string[] | undefined,
  allowed: readonly CategorySlug[] = VISIBLE_CATEGORY_ORDER,
): CategorySlug | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return allowed.find((slug) => slug === value);
}

/** Just enough of a family summary to decide whether it earns a chip. */
export type FamilyAvailability = { slug: CategorySlug; available: number };

/** Chips exist only for families with at least one piece available now. */
export function chipFamilies<T extends FamilyAvailability>(
  families: readonly T[],
): T[] {
  return families.filter((family) => family.available > 0);
}

/**
 * The global "nothing is available online" notice belongs to the unfiltered
 * shop only. A family with nothing on sale is not the whole shop being empty —
 * the filtered heading carries the honest " (0)" and the family's own
 * unavailable pieces stay listed.
 */
export function showsShopEmptyNotice(
  family: CategorySlug | null | undefined,
  availableCount: number,
): boolean {
  return !family && availableCount === 0;
}
