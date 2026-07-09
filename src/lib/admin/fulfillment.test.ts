import { describe, expect, it } from 'vitest';
import {
  computeFulfillmentStage,
  fulfillmentQueueIndex,
  orderFulfillmentQueue,
  shipmentNeedsBuy,
  type FulfillmentOrder,
} from './fulfillment';
import type { AdminOrder } from './data';

function order(overrides: Partial<AdminOrder> = {}): AdminOrder {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    payment_intent_id: 'pi_1',
    status: 'paid',
    currency: 'pln',
    subtotal: 10000,
    shipping: 2000,
    total: 12000,
    email: 'anna@example.com',
    shipping_address: null,
    created_at: '2026-06-18T10:00:00Z',
    paid_at: '2026-06-18T10:05:00Z',
    invoiced_at: null,
    invoice_id: null,
    delivery_method: 'paczkomat',
    receiver_first_name: 'Anna',
    receiver_last_name: 'Kowalska',
    receiver_phone: '+48600100200',
    inpost_target_point: 'KRA010',
    inpost_shipment_id: null,
    inpost_tracking_number: null,
    delivery_status: null,
    locale: 'pl',
    customer_notified_at: null,
    return_requested_at: null,
    items: [{ product_id: 'k01', unit_price: 10000 }],
    ...overrides,
  };
}

describe('computeFulfillmentStage', () => {
  it('returns blocked for a paid shipment order without an InPost shipment', () => {
    expect(computeFulfillmentStage(order())).toBe('blocked');
  });

  it('returns ready for a paid shipment order with an InPost shipment and no status', () => {
    expect(computeFulfillmentStage(order({ inpost_shipment_id: '42' }))).toBe('ready');
  });

  it('keeps initial ShipX statuses in ready', () => {
    expect(computeFulfillmentStage(order({ inpost_shipment_id: '42', delivery_status: 'created' }))).toBe('ready');
    expect(computeFulfillmentStage(order({ inpost_shipment_id: '42', delivery_status: 'confirmed' }))).toBe('ready');
  });

  it('returns in_transit once a meaningful delivery status is present', () => {
    expect(computeFulfillmentStage(order({ inpost_shipment_id: '42', delivery_status: 'delivered' }))).toBe('in_transit');
  });

  it('returns pickup for studio pickup orders', () => {
    expect(computeFulfillmentStage(order({ delivery_method: 'odbior' }))).toBe('pickup');
  });

  it('returns prodigi for a print-only order (never blocked InPost work)', () => {
    const printOnly = order({
      delivery_method: 'kurier',
      items: [{ product_id: 'fap01', unit_price: 30000, variant: { size: 'A3', framed: false } }],
    });
    expect(computeFulfillmentStage(printOnly)).toBe('prodigi');
  });

  it('a defensive mixed order (ceramic + print) stays on the InPost pipeline', () => {
    const mixed = order({
      items: [
        { product_id: 'k01', unit_price: 10000, variant: null },
        { product_id: 'fap01', unit_price: 30000, variant: { size: 'A3', framed: false } },
      ],
    });
    expect(computeFulfillmentStage(mixed)).toBe('blocked');
  });
});

describe('shipmentNeedsBuy', () => {
  it('is false when there is no shipment', () => {
    expect(shipmentNeedsBuy(order())).toBe(false);
  });

  it('is true when a shipment exists but is not confirmed', () => {
    expect(shipmentNeedsBuy(order({ inpost_shipment_id: '42', delivery_status: 'created' }))).toBe(true);
    expect(shipmentNeedsBuy(order({ inpost_shipment_id: '42', delivery_status: null }))).toBe(true);
  });

  it('is false once ShipX reports confirmed', () => {
    expect(shipmentNeedsBuy(order({ inpost_shipment_id: '42', delivery_status: 'confirmed' }))).toBe(false);
  });
});

describe('orderFulfillmentQueue', () => {
  it('includes blocked, ready, and pickup orders, excluding in_transit, non-paid, and unknown delivery methods', () => {
    const rows = [
      order({ id: '00000000-0000-0000-0000-000000000001', delivery_method: 'paczkomat' }),
      order({ id: '00000000-0000-0000-0000-000000000002', delivery_method: 'kurier', inpost_shipment_id: '42' }),
      order({ id: '00000000-0000-0000-0000-000000000003', delivery_method: 'odbior' }),
      order({ id: '00000000-0000-0000-0000-000000000004', inpost_shipment_id: '43', delivery_status: 'delivered' }),
      order({ id: '00000000-0000-0000-0000-000000000005', status: 'pending' }),
      order({ id: '00000000-0000-0000-0000-000000000006', delivery_method: 'unknown' }),
      order({
        id: '00000000-0000-0000-0000-000000000007',
        delivery_method: 'kurier',
        items: [{ product_id: 'fap01', unit_price: 30000, variant: { size: 'A3' } }],
      }),
    ];

    expect(orderFulfillmentQueue(rows).map((o) => o.id.slice(-1))).toEqual(['1', '2', '3']);
  });

  it('sorts FIFO by paid_at, falling back to created_at', () => {
    const rows = [
      order({ id: '00000000-0000-0000-0000-000000000003', created_at: '2026-06-18T09:00:00Z', paid_at: '2026-06-18T09:30:00Z' }),
      order({ id: '00000000-0000-0000-0000-000000000001', created_at: '2026-06-18T08:00:00Z', paid_at: null }),
      order({ id: '00000000-0000-0000-0000-000000000002', created_at: '2026-06-18T08:30:00Z', paid_at: '2026-06-18T08:45:00Z' }),
    ];

    expect(orderFulfillmentQueue(rows).map((o) => o.id.slice(-1))).toEqual(['1', '2', '3']);
  });
});

describe('fulfillmentQueueIndex', () => {
  const queue = orderFulfillmentQueue([
    order({ id: '00000000-0000-0000-0000-000000000001', paid_at: '2026-06-18T10:00:00Z' }),
    order({ id: '00000000-0000-0000-0000-000000000002', paid_at: '2026-06-18T11:00:00Z' }),
    order({ id: '00000000-0000-0000-0000-000000000003', paid_at: '2026-06-18T12:00:00Z' }),
  ]) as FulfillmentOrder[];

  it('returns index, total, previous id, and next id', () => {
    expect(fulfillmentQueueIndex(queue, '00000000-0000-0000-0000-000000000002')).toEqual({
      index: 1,
      total: 3,
      prevId: '00000000-0000-0000-0000-000000000001',
      nextId: '00000000-0000-0000-0000-000000000003',
    });
  });

  it('returns -1 and no neighbours when the order is not in the queue', () => {
    expect(fulfillmentQueueIndex(queue, '00000000-0000-0000-0000-000000000099')).toEqual({
      index: -1,
      total: 3,
      prevId: null,
      nextId: null,
    });
  });
});
