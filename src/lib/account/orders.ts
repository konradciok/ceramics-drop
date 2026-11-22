/* ============================================================
   Account order reads (server-only, service-role).
   ------------------------------------------------------------
   The account pages are server components calling these helpers — there are
   deliberately NO /api/account/* endpoints. Authorization is row-ownership by
   construction: every query filters by the JWT-verified user id, and the
   detail read returns null (→ 404) on any mismatch, matching the
   /api/returns anti-enumeration posture. RLS stays deny-all; reads go through
   the existing service-role client exactly like src/lib/admin/data.ts.
   ============================================================ */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isUuid } from '@/lib/uuid';

/** Only settled outcomes appear in the account (plan §6): no pending/failed/expired. */
const LISTED_STATUSES = ['paid', 'refunded'];
export const ACCOUNT_LIST_LIMIT = 50;

export type AccountOrderItem = {
  product_id: string;
  unit_price: number;
  /** NULL = ceramic; jsonb print snapshot (size/framed/mount/frameColour, …). */
  variant: unknown;
};

/** Columns the account surfaces need — a subset of `orders`, never `marketing`. */
export type AccountOrder = {
  id: string;
  status: string;
  currency: string;
  subtotal: number;
  shipping: number;
  total: number;
  gift_card_amount?: number;
  gift_card_balance_after?: number | null;
  cash_amount?: number;
  created_at: string;
  paid_at: string | null;
  delivery_method: string | null;
  fulfilment_type: string | null;
  delivery_status: string | null;
  inpost_tracking_number: string | null;
  inpost_target_point: string | null;
  shipping_address: unknown;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  items: AccountOrderItem[];
};

const ORDER_COLUMNS =
  'id, status, currency, subtotal, shipping, total, gift_card_amount, gift_card_balance_after, cash_amount, created_at, paid_at, delivery_method, fulfilment_type, delivery_status, inpost_tracking_number, inpost_target_point, shipping_address, receiver_first_name, receiver_last_name';

type RawAccountOrder = Omit<AccountOrder, 'items'> & { order_items: AccountOrderItem[] | null };

function normalise(row: RawAccountOrder): AccountOrder {
  const { order_items, ...rest } = row;
  return { ...rest, items: order_items ?? [] };
}

export async function listAccountOrders(
  userId: string,
  opts?: { supabase?: SupabaseClient },
): Promise<{ orders: AccountOrder[] }> {
  const supabase = opts?.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase
    .from('orders')
    .select(`${ORDER_COLUMNS}, order_items(product_id, unit_price, variant)`)
    .eq('user_id', userId)
    .in('status', LISTED_STATUSES)
    .order('created_at', { ascending: false })
    .limit(ACCOUNT_LIST_LIMIT);
  if (error) throw error;
  return { orders: ((data as unknown as RawAccountOrder[] | null) ?? []).map(normalise) };
}

/**
 * Ownership-filtered single-order read for the detail page. Returns null for
 * unknown ids, other users' orders, and unsettled statuses alike — the page
 * 404s uniformly (anti-enumeration, house pattern).
 */
export async function getAccountOrder(
  orderId: string,
  userId: string,
  opts?: { supabase?: SupabaseClient },
): Promise<{ order: AccountOrder } | null> {
  if (!isUuid(orderId)) return null;
  const supabase = opts?.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase
    .from('orders')
    .select(`${ORDER_COLUMNS}, order_items(product_id, unit_price, variant)`)
    .eq('id', orderId)
    .eq('user_id', userId)
    .in('status', LISTED_STATUSES)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { order: normalise(data as unknown as RawAccountOrder) };
}
