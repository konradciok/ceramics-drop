/**
 * Private-sale link helpers. A token in the `private_sales` table maps to an exact
 * set of product ids that may be bought via a secret `/koszyk?sale=<TOKEN>` link,
 * even though the pieces are `sold` in the public catalogue. The atomic reservation
 * lives in the `reserve_private_sale_pieces` RPC; this module covers read-side
 * validation (the GET endpoint + the checkout pre-check). See
 * docs/plans/private-sale-cart-link.md.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type ActivePrivateSale = { id: string; product_ids: string[] };

/** Sentinel the RPC returns when the token is missing / consumed / expired. */
export const INVALID_TOKEN_SENTINEL = '__invalid_token__';

/** Trim a raw token query value to a usable string, or null. Bounds length to avoid abuse. */
export function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 128) return null;
  return t;
}

/**
 * Look up the active (unconsumed, unexpired) sale for a token. Returns null for
 * missing / consumed / expired / invalid tokens — callers map that to a uniform
 * 404 so the endpoint never signals whether a token exists.
 */
export async function loadActivePrivateSale(
  supabase: SupabaseClient,
  token: string,
): Promise<ActivePrivateSale | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('private_sales')
    .select('id, product_ids')
    .eq('token', token)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; product_ids: string[] };
  if (!Array.isArray(row.product_ids) || row.product_ids.length === 0) return null;
  return { id: row.id, product_ids: row.product_ids };
}
