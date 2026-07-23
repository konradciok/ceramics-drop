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
  'id, status, currency, subtotal, shipping, total, created_at, paid_at, delivery_method, fulfilment_type, delivery_status, inpost_tracking_number, inpost_target_point, shipping_address, receiver_first_name, receiver_last_name';

type RawAccountOrder = Omit<AccountOrder, 'items'> & { order_items: AccountOrderItem[] | null };

function normalise(row: RawAccountOrder): AccountOrder {
  const { order_items, ...rest } = row;
  return { ...rest, items: order_items ?? [] };
}

/** Latest fulfilment_jobs.status per print order — mirrors the "latest job" rule in prodigi/callbacks.ts. */
export type AccountFulfilment = {
  latestJobStatus: string | null;
  prodigiTracking: {
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippedAt: string | null;
  } | null;
};

export async function listAccountOrders(
  userId: string,
  opts?: { supabase?: SupabaseClient },
): Promise<{ orders: AccountOrder[]; jobStatusByOrder: Map<string, string> }> {
  const supabase = opts?.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase
    .from('orders')
    .select(`${ORDER_COLUMNS}, order_items(product_id, unit_price, variant)`)
    .eq('user_id', userId)
    .in('status', LISTED_STATUSES)
    .order('created_at', { ascending: false })
    .limit(ACCOUNT_LIST_LIMIT);
  if (error) throw error;
  const orders = ((data as unknown as RawAccountOrder[] | null) ?? []).map(normalise);

  // Status chips for print orders need the latest job per order; one query for
  // the whole page (the per-user set is tiny), newest-first so the first row
  // seen per order wins.
  const printOrderIds = orders.filter((o) => o.fulfilment_type === 'prodigi').map((o) => o.id);
  const jobStatusByOrder = new Map<string, string>();
  if (printOrderIds.length > 0) {
    const { data: jobs, error: jobsError } = await supabase
      .from('fulfilment_jobs')
      .select('order_id, status, created_at')
      .in('order_id', printOrderIds)
      .order('created_at', { ascending: false });
    if (jobsError) throw jobsError;
    for (const job of (jobs as { order_id: string; status: string }[] | null) ?? []) {
      if (!jobStatusByOrder.has(job.order_id)) jobStatusByOrder.set(job.order_id, job.status);
    }
  }
  return { orders, jobStatusByOrder };
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
): Promise<{ order: AccountOrder; fulfilment: AccountFulfilment } | null> {
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
  const order = normalise(data as unknown as RawAccountOrder);

  const fulfilment: AccountFulfilment = { latestJobStatus: null, prodigiTracking: null };
  if (order.fulfilment_type === 'prodigi') {
    const [jobRes, prodigiRes] = await Promise.all([
      supabase
        .from('fulfilment_jobs')
        .select('status')
        .eq('order_id', order.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('prodigi_orders')
        .select('carrier, tracking_number, tracking_url, shipped_at')
        .eq('order_id', order.id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (jobRes.error) throw jobRes.error;
    if (prodigiRes.error) throw prodigiRes.error;
    fulfilment.latestJobStatus = (jobRes.data as { status: string } | null)?.status ?? null;
    const prodigi = prodigiRes.data as {
      carrier: string | null;
      tracking_number: string | null;
      tracking_url: string | null;
      shipped_at: string | null;
    } | null;
    if (prodigi) {
      fulfilment.prodigiTracking = {
        carrier: prodigi.carrier,
        trackingNumber: prodigi.tracking_number,
        trackingUrl: prodigi.tracking_url,
        shippedAt: prodigi.shipped_at,
      };
    }
  }
  return { order, fulfilment };
}
