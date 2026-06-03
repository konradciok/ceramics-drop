import { unstable_cache } from 'next/cache';
import { getSupabaseAdmin } from './supabase';

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
