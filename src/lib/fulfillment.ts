/** Minimal shape of the Supabase head-count query chain. */
export interface CeramicCountClient {
  from(table: string): {
    select(columns: string, opts: { count: 'exact'; head: true }): {
      eq(column: string, value: string): {
        is(column: string, value: null): Promise<{ count: number | null; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * Count ceramic line items (variant IS NULL) only. Print items have no
 * piece_state row; counting them would make every print order look
 * under-fulfilled and trigger an auto-refund.
 */
export function countCeramicOrderItems(
  supabase: CeramicCountClient,
  orderId: string,
): Promise<{ count: number | null; error: { message: string } | null }> {
  return supabase
    .from('order_items')
    .select('*', { count: 'exact', head: true })
    .eq('order_id', orderId)
    .is('variant', null);
}

/** True when fewer ceramics ended up sold than expected. */
export function isUnderfulfilled(fulfilledCount: number, expectedCount: number): boolean {
  return fulfilledCount < expectedCount;
}
