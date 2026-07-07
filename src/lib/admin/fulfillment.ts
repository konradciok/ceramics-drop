import { needsShipment } from '@/lib/shipx';
import type { ProductRef } from './products';
import { productRef } from './products';
import { listOrders, getOrder, isPrintOnly, type AdminOrder, type OrderItem } from './data';

export type FulfillmentStage = 'blocked' | 'ready' | 'in_transit' | 'pickup' | 'prodigi';

export type FulfillmentOrder = AdminOrder & {
  stage: FulfillmentStage;
  itemsEnriched: Array<OrderItem & { ref: ProductRef }>;
};

const INITIAL_SHIPMENT_STATUSES = new Set(['created', 'confirmed']);

function isShipmentMethod(method: string | null | undefined): method is 'paczkomat' | 'kurier' {
  return method === 'paczkomat' || method === 'kurier';
}

function meaningfulTransitStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return !!normalized && !INITIAL_SHIPMENT_STATUSES.has(normalized);
}

export function computeFulfillmentStage(order: AdminOrder): FulfillmentStage {
  // Print-only orders are Prodigi's work — never `blocked` InPost work. The
  // queue below excludes them; their real state lives in prodigi_orders.
  if (isPrintOnly(order)) return 'prodigi';
  if (order.delivery_method === 'odbior') return 'pickup';
  if (!isShipmentMethod(order.delivery_method)) return 'in_transit';
  if (!needsShipment(order.delivery_method)) return 'pickup';
  if (!order.inpost_shipment_id) return 'blocked';
  return meaningfulTransitStatus(order.delivery_status) ? 'in_transit' : 'ready';
}

function enrich(order: AdminOrder): FulfillmentOrder {
  return {
    ...order,
    stage: computeFulfillmentStage(order),
    itemsEnriched: order.items.map((it) => ({ ...it, ref: productRef(it.product_id, it.variant) })),
  };
}

function queueTimestamp(order: AdminOrder): string {
  return order.paid_at ?? order.created_at;
}

export function orderFulfillmentQueue(orders: AdminOrder[]): FulfillmentOrder[] {
  return orders
    .filter((order) => order.status === 'paid')
    .map(enrich)
    .filter((order) => order.stage === 'blocked' || order.stage === 'ready' || order.stage === 'pickup')
    .sort((a, b) => queueTimestamp(a).localeCompare(queueTimestamp(b)));
}

export async function listFulfillmentQueue(): Promise<FulfillmentOrder[]> {
  const orders = await listOrders({ status: 'paid' }, { withItems: true });
  return orderFulfillmentQueue(orders);
}

export async function getFulfillmentOrder(id: string): Promise<FulfillmentOrder | null> {
  const order = await getOrder(id);
  if (!order) return null;
  return enrich(order);
}

export function fulfillmentQueueIndex(
  queue: FulfillmentOrder[],
  id: string,
): { index: number; total: number; prevId: string | null; nextId: string | null } {
  const index = queue.findIndex((order) => order.id === id);
  return {
    index,
    total: queue.length,
    prevId: index > 0 ? queue[index - 1].id : null,
    nextId: index >= 0 && index < queue.length - 1 ? queue[index + 1].id : null,
  };
}
