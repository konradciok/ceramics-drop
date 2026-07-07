import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockAdminSupabase } = vi.hoisted(() => ({ mockAdminSupabase: vi.fn() }));
vi.mock('./clients', () => ({ adminSupabase: mockAdminSupabase }));

import { getKpis, isPrintOnly } from './data';

/** Thenable query chain: builder methods return the chain; awaiting resolves `result`. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  for (const m of ['select', 'eq', 'order']) chain[m] = vi.fn().mockReturnValue(chain);
  return chain;
}

function orderRow(overrides: Record<string, unknown> = {}) {
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
    created_at: '2026-07-01T10:00:00Z',
    paid_at: '2026-07-01T10:05:00Z',
    invoiced_at: null,
    invoice_id: null,
    delivery_method: 'paczkomat',
    receiver_first_name: 'Anna',
    receiver_last_name: 'Kowalska',
    receiver_phone: null,
    inpost_target_point: 'KRA010',
    inpost_shipment_id: null,
    inpost_tracking_number: null,
    delivery_status: null,
    locale: 'pl',
    customer_notified_at: null,
    return_requested_at: null,
    order_items: [{ product_id: 'k01', unit_price: 10000, variant: null }],
    ...overrides,
  };
}

const PRINT_ITEMS = [{ product_id: 'fap01', unit_price: 30000, variant: { size: 'A3', framed: true } }];

describe('isPrintOnly', () => {
  it('is false for ceramic items (variant null) and empty item lists', () => {
    expect(isPrintOnly({ items: [{ product_id: 'k01', unit_price: 1, variant: null }] })).toBe(false);
    expect(isPrintOnly({ items: [] })).toBe(false);
  });

  it('is true only when every item is a print', () => {
    expect(isPrintOnly({ items: [{ product_id: 'fap01', unit_price: 1, variant: { size: 'A3' } }] })).toBe(true);
    expect(
      isPrintOnly({
        items: [
          { product_id: 'fap01', unit_price: 1, variant: { size: 'A3' } },
          { product_id: 'k01', unit_price: 1, variant: null },
        ],
      }),
    ).toBe(false);
  });
});

describe('getKpis awaitingFulfillment', () => {
  beforeEach(() => {
    mockAdminSupabase.mockReset();
  });

  function setupOrders(rows: unknown[]) {
    mockAdminSupabase.mockReturnValue({
      from: (table: string) =>
        table === 'orders'
          ? makeChain({ data: rows, error: null })
          : makeChain({ data: [], error: null }),
    });
  }

  it('counts unshipped ceramic shipment orders but excludes print-only orders', async () => {
    setupOrders([
      // Ceramic, unshipped → counts.
      orderRow({ id: '00000000-0000-0000-0000-000000000001' }),
      // Print-only, unshipped kurier — Prodigi's work, must NOT count.
      orderRow({ id: '00000000-0000-0000-0000-000000000002', delivery_method: 'kurier', order_items: PRINT_ITEMS }),
      // Ceramic, already shipped → not awaiting.
      orderRow({ id: '00000000-0000-0000-0000-000000000003', inpost_shipment_id: '42' }),
      // Pickup → not awaiting.
      orderRow({ id: '00000000-0000-0000-0000-000000000004', delivery_method: 'odbior' }),
    ]);

    const kpis = await getKpis();

    expect(kpis.awaitingFulfillment).toBe(1);
    // Print orders still count as paid revenue/status — only the InPost queue depth excludes them.
    expect(kpis.ordersByStatus.paid).toBe(4);
  });
});
