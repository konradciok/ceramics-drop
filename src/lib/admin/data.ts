/**
 * LOCAL-ONLY admin reads. All server-side, service-role (bypasses RLS) via
 * `adminSupabase()`. The dataset is tiny (one-of-a-kind catalogue), so we fetch
 * and reduce in JS rather than push aggregates into SQL — simpler and plenty
 * fast. Source of truth = Supabase; the order-detail page enriches with Stripe.
 */
import { adminSupabase } from './clients';

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
export const ORDER_STATUSES: OrderStatus[] = ['pending', 'paid', 'failed', 'expired', 'refunded'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Guard before querying uuid columns — an invalid literal makes Postgres throw. */
export function isUuid(s: string | null | undefined): s is string {
  return !!s && UUID_RE.test(s);
}

/** `variant` is the ceramics⇄prints discriminator: NULL = ceramic, jsonb = print. */
export type OrderItem = { product_id: string; unit_price: number; variant?: unknown };

/** True when every line item is a print (Prodigi fulfils it — never InPost work). */
export function isPrintOnly(order: Pick<AdminOrder, 'items'>): boolean {
  return order.items.length > 0 && order.items.every((it) => it.variant != null);
}

/** An order row with its line items. Columns mirror the `orders` table. */
export type AdminOrder = {
  id: string;
  payment_intent_id: string | null;
  status: OrderStatus;
  currency: string;
  subtotal: number;
  shipping: number;
  total: number;
  email: string | null;
  shipping_address: Record<string, unknown> | null;
  created_at: string;
  paid_at: string | null;
  invoiced_at: string | null;
  invoice_id: string | null;
  delivery_method: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  inpost_target_point: string | null;
  inpost_shipment_id: string | null;
  inpost_tracking_number: string | null;
  delivery_status: string | null;
  locale: string | null;
  customer_notified_at: string | null;
  return_requested_at: string | null;
  items: OrderItem[];
};

const ORDER_COLUMNS =
  'id, payment_intent_id, status, currency, subtotal, shipping, total, email, shipping_address, created_at, paid_at, invoiced_at, invoice_id, delivery_method, receiver_first_name, receiver_last_name, receiver_phone, inpost_target_point, inpost_shipment_id, inpost_tracking_number, delivery_status, locale, customer_notified_at, return_requested_at';

type RawOrder = Omit<AdminOrder, 'items'> & { order_items: OrderItem[] | null };

function normalise(row: RawOrder): AdminOrder {
  const { order_items, ...rest } = row;
  return { ...rest, items: order_items ?? [] };
}

export async function listOrders(
  filter?: { status?: OrderStatus; email?: string },
  opts?: { withItems?: boolean },
): Promise<AdminOrder[]> {
  const supabase = adminSupabase();
  // Line items are only needed by the order-detail page; callers that just
  // count/sum (KPIs) skip the join. The select string is dynamic, so supabase's
  // literal-type query parser can't infer the row shape — cast through unknown.
  const columns = opts?.withItems === false ? ORDER_COLUMNS : `${ORDER_COLUMNS}, order_items(product_id, unit_price, variant)`;
  let query = supabase.from('orders').select(columns).order('created_at', { ascending: false });
  if (filter?.status) query = query.eq('status', filter.status);
  if (filter?.email) query = query.eq('email', filter.email);
  const { data, error } = await query;
  if (error) throw error;
  return ((data as unknown as RawOrder[] | null) ?? []).map(normalise);
}

export async function getOrder(id: string): Promise<AdminOrder | null> {
  if (!isUuid(id)) return null;
  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select(`${ORDER_COLUMNS}, order_items(product_id, unit_price, variant)`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? normalise(data as RawOrder) : null;
}

export type PieceStatus = 'available' | 'reserved' | 'sold';
export type Piece = {
  product_id: string;
  status: PieceStatus;
  reserved_until: string | null;
  order_id: string | null;
  /** reserved but the hold has lapsed (stuck — candidate for release). */
  reservedExpired: boolean;
};

type RawPiece = Omit<Piece, 'reservedExpired'>;

export async function listInventory(): Promise<Piece[]> {
  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('piece_state')
    .select('product_id, status, reserved_until, order_id')
    .order('status', { ascending: true })
    .order('product_id', { ascending: true });
  if (error) throw error;
  // Current-time comparison lives here (a plain async data fn), not in a React
  // render, so it stays out of the component-purity rule.
  const now = Date.now();
  return ((data as RawPiece[] | null) ?? []).map((p) => ({
    ...p,
    reservedExpired: p.status === 'reserved' && !!p.reserved_until && new Date(p.reserved_until).getTime() < now,
  }));
}

export const NO_EMAIL = '(brak e-maila)';

export type Customer = {
  /** Real address, or the NO_EMAIL sentinel for orders with no email. */
  email: string;
  /** False when `email` is the sentinel — the row shouldn't link to an email filter. */
  emailKnown: boolean;
  orders: number;
  paidOrders: number;
  /** Paid spend in MINOR units, keyed by currency — never summed across currencies. */
  spendByCurrency: Record<string, number>;
  lastOrderAt: string;
  locale: string | null;
  name: string | null;
  phone: string | null;
};

/** Customers don't have their own table — derive them by grouping orders on email. */
export async function listCustomers(): Promise<Customer[]> {
  // Orders arrive newest-first; the first row seen per email is the most recent.
  const orders = await listOrders();
  const byEmail = new Map<string, Customer>();
  for (const o of orders) {
    const emailKnown = !!o.email;
    const email = o.email ?? NO_EMAIL;
    const name = [o.receiver_first_name, o.receiver_last_name].filter(Boolean).join(' ') || null;
    const phone = o.receiver_phone?.trim() || null;
    let c = byEmail.get(email);
    if (!c) {
      c = { email, emailKnown, orders: 0, paidOrders: 0, spendByCurrency: {}, lastOrderAt: o.created_at, locale: o.locale, name, phone };
      byEmail.set(email, c);
    }
    c.orders += 1;
    if (o.status === 'paid') {
      c.paidOrders += 1;
      c.spendByCurrency[o.currency] = (c.spendByCurrency[o.currency] ?? 0) + o.total;
    }
    // Newest order (seen first) wins for name/locale/phone; fall back to older orders
    // only when the newer one lacked the value.
    c.name = c.name ?? name;
    c.locale = c.locale ?? o.locale;
    c.phone = c.phone ?? phone;
  }
  return [...byEmail.values()].sort((a, b) => b.lastOrderAt.localeCompare(a.lastOrderAt));
}

export type Kpis = {
  ordersByStatus: Record<OrderStatus, number>;
  paidRevenue: Record<string, number>; // currency → minor units
  piecesByStatus: Record<PieceStatus, number>;
  awaitingFulfillment: number;
  recent: AdminOrder[];
};

export async function getKpis(): Promise<Kpis> {
  // Items are joined here (despite KPIs being count/sum) because
  // awaitingFulfillment must exclude print-only orders — the discriminator
  // lives on order_items.variant. Dataset is tiny; the join is cheap.
  const [orders, pieces] = await Promise.all([listOrders(), listInventory()]);

  const ordersByStatus: Record<OrderStatus, number> = {
    pending: 0, paid: 0, failed: 0, expired: 0, refunded: 0,
  };
  const paidRevenue: Record<string, number> = {};
  let awaitingFulfillment = 0;
  for (const o of orders) {
    ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1;
    if (o.status === 'paid') {
      paidRevenue[o.currency] = (paidRevenue[o.currency] ?? 0) + o.total;
      // awaitingFulfillment is the InPost queue depth — print-only orders are
      // Prodigi's work and never get an inpost_shipment_id.
      if (!o.inpost_shipment_id && o.delivery_method !== 'odbior' && !isPrintOnly(o)) awaitingFulfillment += 1;
    }
  }

  const piecesByStatus: Record<PieceStatus, number> = { available: 0, reserved: 0, sold: 0 };
  for (const p of pieces) piecesByStatus[p.status] = (piecesByStatus[p.status] ?? 0) + 1;

  return { ordersByStatus, paidRevenue, piecesByStatus, awaitingFulfillment, recent: orders.slice(0, 8) };
}
