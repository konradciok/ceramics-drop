import { cache } from 'react';
import { getSupabaseAdmin } from './supabase';
import { supabaseTimeout } from './supabase-timeout';
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

type PieceStateRow = { product_id: string; status: string; showroom: boolean };

/**
 * `piece_state` rows relevant to either sold or showroom state, fetched once
 * and de-duplicated within a single request via React's `cache()`. Replaces
 * two independent `unstable_cache`-wrapped queries — the OpenNext deployment's
 * tag cache is a dummy stub (no persistent invalidation), so that wrapping
 * provided no real cross-request caching; `cache()` here is request-scoped
 * memoization only, not a claim of durable invalidation.
 */
const fetchPieceState = cache(async (): Promise<PieceStateRow[]> => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('piece_state')
    .select('product_id, status, showroom')
    .or('status.eq.sold,showroom.eq.true')
    .abortSignal(supabaseTimeout());
  if (error) throw error;
  return (data ?? []) as PieceStateRow[];
});

/** Sold product ids. */
export async function getSoldIds(): Promise<string[]> {
  const rows = await fetchPieceState();
  return rows.filter((r) => r.status === 'sold').map((r) => r.product_id);
}

/**
 * Product ids retired into the showroom (visible but not purchasable).
 * Independent of sold state — a piece can be showroom whether it sold or not.
 */
export async function getShowroomIds(): Promise<string[]> {
  const rows = await fetchPieceState();
  return rows.filter((r) => r.showroom).map((r) => r.product_id);
}

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
    supabase.from('piece_state').select('product_id, status').eq('showroom', true).abortSignal(supabaseTimeout()),
    supabase.from('drops').select('id, label').abortSignal(supabaseTimeout()),
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
