import { unstable_cache } from 'next/cache';
import { getSupabaseAdmin } from './supabase';
import { resolveKnownProducts, CATEGORY_ORDER } from './products';
import type { Product } from './types';

export type PieceRow = {
  status: 'available' | 'reserved' | 'sold';
  reserved_until: string | null;
};

/** Pure availability rule: not sold AND (no live hold). */
export function isAvailable(row: PieceRow, now: Date): boolean {
  if (row.status === 'sold') return false;
  if (row.status === 'reserved' && row.reserved_until && new Date(row.reserved_until) > now) {
    return false;
  }
  return true;
}

/**
 * Sold product ids, cached under the `inventory` tag. The Stripe webhook calls
 * revalidateTag('inventory') on a sale so collection pages refresh promptly
 * while otherwise serving cached, fast responses.
 */
export const getSoldIds = unstable_cache(
  async (): Promise<string[]> => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('piece_state')
      .select('product_id')
      .eq('status', 'sold');
    if (error) throw error;
    return (data ?? []).map((r) => r.product_id as string);
  },
  ['sold-ids'],
  { tags: ['inventory'], revalidate: 300 },
);

/**
 * Product ids retired into the showroom (visible but not purchasable), cached
 * under the same `inventory` tag as sold ids so admin toggles refresh promptly.
 * Independent of sold state — a piece can be showroom whether it sold or not.
 */
export const getShowroomIds = unstable_cache(
  async (): Promise<string[]> => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('piece_state')
      .select('product_id')
      .eq('showroom', true);
    if (error) throw error;
    return (data ?? []).map((r) => r.product_id as string);
  },
  ['showroom-ids'],
  { tags: ['inventory'], revalidate: 300 },
);

/** A showroom piece resolved for display: the product (sold + showroom merged) plus its drop label. */
export type ShowroomEntry = { product: Product; dropLabel: string | null };

/**
 * Every showroom piece across all categories, in CATEGORY_ORDER, each carrying
 * live sold state and its drop's display label (from the `drops` table). Used
 * by the /showroom gallery. Not cached — /showroom is force-dynamic — but a
 * Supabase outage degrades to an empty gallery rather than throwing.
 */
export async function getShowroomProducts(): Promise<ShowroomEntry[]> {
  const supabase = getSupabaseAdmin();
  const [{ data: pieces, error: pieceErr }, { data: drops, error: dropErr }] = await Promise.all([
    supabase.from('piece_state').select('product_id, status').eq('showroom', true),
    supabase.from('drops').select('id, label'),
  ]);
  if (pieceErr) throw pieceErr;
  if (dropErr) throw dropErr;

  const soldSet = new Set(
    (pieces ?? []).filter((p) => p.status === 'sold').map((p) => p.product_id as string),
  );
  const dropLabel = new Map((drops ?? []).map((d) => [d.id as string, d.label as string]));
  const order = new Map(CATEGORY_ORDER.map((slug, i) => [slug, i]));

  return (await resolveKnownProducts((pieces ?? []).map((p) => p.product_id as string)))
    .map((product) => ({
      product: { ...product, showroom: true, sold: soldSet.has(product.id) },
      dropLabel: dropLabel.get(product.dropId) ?? null,
    }))
    .sort((a, b) => {
      const byCat = (order.get(a.product.category) ?? 0) - (order.get(b.product.category) ?? 0);
      return byCat !== 0 ? byCat : a.product.num.localeCompare(b.product.num);
    });
}
