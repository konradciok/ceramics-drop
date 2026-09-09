import { cache } from 'react';
import { getSupabaseAdmin } from './supabase';
import { supabaseTimeout } from './supabase-timeout';

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
