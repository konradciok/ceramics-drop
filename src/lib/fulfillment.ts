/* ============================================================
   Fulfillment count guard — ceramic-only line counting.
   ------------------------------------------------------------
   The webhook's markPaid compares how many pieces actually ended up `sold`
   (piece_state) against how many were EXPECTED. Only ceramics have a
   piece_state row, so the expected count must exclude fine-art prints
   (variant IS NOT NULL). Counting prints here would make every print order
   look under-fulfilled and trigger an auto-refund (plan Risk #1).

   Extracted from the route handler so this exact query is unit-testable
   without importing the Next.js runtime.
   ============================================================ */

/** Minimal shape of the Supabase head-count query chain used below. */
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
 * Count the order's CERAMIC line items (variant IS NULL) — the pieces that must
 * reach `sold` for the order to be considered fulfilled. A print-only order
 * returns 0, so it passes the guard with zero pieces sold.
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

/**
 * Whether the order is under-fulfilled: fewer ceramic pieces ended up `sold`
 * than were expected. True ⇒ refund + fail. Equal (incl. 0 = 0 for print-only) ⇒ pass.
 */
export function isUnderfulfilled(fulfilledCount: number, expectedCount: number): boolean {
  return fulfilledCount < expectedCount;
}
