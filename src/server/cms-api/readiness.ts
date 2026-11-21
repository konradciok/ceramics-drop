import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductResponse } from './types';

export type ReadinessResult = { revision: number; ready: boolean; blockers: string[]; warnings: string[] };

/** Shown on every print product: prints moved to their own shop (2026-11). */
export const PRINTS_RETIRED_BLOCKER = 'Druki są wycofane — sprzedaż przeniesiona do anna-ciok.com. Druku nie można opublikować.';

/**
 * Publication readiness. Ceramics are always publishable (warnings only); a
 * print can no longer be published at all — the print-asset pipeline that
 * used to gate it is gone with the print shop.
 */
export async function computeReadiness(_supabase: SupabaseClient, product: ProductResponse): Promise<ReadinessResult> {
  const warnings: string[] = [];
  const { title } = product.draft;
  if (!title.en && !title.es && !title.de) {
    warnings.push('Brak EN, ES lub DE: sklep użyje treści PL.');
  }

  if (product.draft.type === 'ceramic') {
    return { revision: product.revision, ready: true, blockers: [], warnings };
  }
  return { revision: product.revision, ready: false, blockers: [PRINTS_RETIRED_BLOCKER], warnings };
}
