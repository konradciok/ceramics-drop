/* ============================================================
   Drop visibility — which batch of pieces the storefront shows.
   ------------------------------------------------------------
   Every ceramic belongs to one drop (`products.drop_id` → `drops`). The
   drop's status decides where its pieces appear:

     upcoming → hidden   loaded ahead of launch; PDP 404, listed nowhere
     active   → current  the shop: /sklep, category pages, home, siblings
     ended    → archive  /showroom "Wcześniejsze prace" + a live PDP

   A product's own `status` (draft/hidden/archived) still withdraws a single
   piece on top of this. Pure module: no IO, safe in client components.
   ============================================================ */

export type DropTier = 'current' | 'archive' | 'hidden';

export type DropStatusRow = { id: string; status: string };

/**
 * Tier for one drop id.
 *
 * When the drops table could not be read (`failed`), only the code-declared
 * fallback drop is shown as current; every other drop stays hidden, so an
 * outage can never leak an upcoming batch. Callers mark the request degraded
 * in that case so crawlers get a 503 rather than a 404.
 */
export function dropTier(
  dropId: string,
  drops: readonly DropStatusRow[],
  failed: boolean,
  fallbackCurrentDropId: string,
): DropTier {
  if (failed) return dropId === fallbackCurrentDropId ? 'current' : 'hidden';
  const status = drops.find((d) => d.id === dropId)?.status;
  if (status === 'active') return 'current';
  if (status === 'ended') return 'archive';
  // upcoming, or a drop row that does not exist yet.
  return 'hidden';
}

type DropTranslator = {
  (key: string): string;
  has(key: string): boolean;
};

/**
 * Customer-facing name of a drop, from the `drops.<id>` messages namespace
 * (translated per locale, added with each new drop). An id without copy yet
 * renders as an empty string, so the UI drops the clause instead of showing a
 * raw id.
 */
export function dropName(t: DropTranslator, dropId: string): string {
  const key = `drops.${dropId}`;
  return t.has(key) ? t(key) : '';
}

/** "01–29" style range over display numbers (assumed zero-padded). */
export function numRange(nums: readonly string[]): string {
  if (nums.length === 0) return '';
  const sorted = [...nums].sort((a, b) => Number(a) - Number(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? first : `${first}–${last}`;
}
