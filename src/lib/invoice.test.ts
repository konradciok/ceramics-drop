import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOrderInvoice } from './invoice';

/**
 * Covers the regression where invoices were created EMPTY (pending invoice items
 * default to `exclude`), auto-paid at 0 zł on finalization, and the explicit
 * pay() threw "Invoice is already paid" — so no invoice was recorded or sent.
 */

const ORDER = {
  id: 'ord-1',
  payment_intent_id: 'pi_1',
  status: 'paid',
  invoiced_at: null,
  invoice_id: null,
  email: 'buyer@example.com',
  shipping_address: null,
  receiver_first_name: 'Test',
  receiver_last_name: 'Buyer',
  receiver_phone: '600100200',
  delivery_method: 'paczkomat',
  shipping: 2000,
  total: 10500,
};

const ITEMS = [{ order_id: 'ord-1', product_id: 'k01', unit_price: 9000 }];

const stripeMock = {
  customers: { create: vi.fn(), list: vi.fn(), update: vi.fn() },
  invoiceItems: { create: vi.fn() },
  invoices: {
    create: vi.fn(),
    retrieve: vi.fn(),
    finalizeInvoice: vi.fn(),
    pay: vi.fn(),
    sendInvoice: vi.fn(),
  },
};

const updateEq = vi.fn();
const supabaseMock = {
  from: vi.fn((table: string) => {
    if (table === 'orders' && fromMode === 'select') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: orderRow }) }) }) };
    }
    if (table === 'order_items') {
      fromMode = 'update'; // orders is selected first, items second, update third
      return { select: () => ({ eq: async () => ({ data: itemRows }) }) };
    }
    return { update: () => ({ eq: updateEq }) };
  }),
};
let fromMode: 'select' | 'update' = 'select';
let orderRow: Record<string, unknown> | null = ORDER;
let itemRows: Array<Record<string, unknown>> | null = ITEMS;

vi.mock('./stripe', () => ({ getStripe: () => stripeMock }));
vi.mock('./supabase', () => ({ getSupabaseAdmin: () => supabaseMock }));

beforeEach(() => {
  vi.clearAllMocks();
  fromMode = 'select';
  orderRow = { ...ORDER };
  itemRows = [...ITEMS];
  updateEq.mockResolvedValue({ error: null });
  stripeMock.customers.list.mockResolvedValue({ data: [] });
  stripeMock.customers.create.mockResolvedValue({ id: 'cus_1' });
  stripeMock.customers.update.mockResolvedValue({ id: 'cus_updated' });
  stripeMock.invoices.create.mockResolvedValue({ id: 'in_1', status: 'draft', total: 0 });
  stripeMock.invoiceItems.create.mockResolvedValue({ id: 'ii_1' });
  // First retrieve: live status after create; second: total check after items.
  stripeMock.invoices.retrieve
    .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 0 })
    .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 10500 });
  stripeMock.invoices.finalizeInvoice.mockResolvedValue({ id: 'in_1', status: 'open', total: 10500 });
  stripeMock.invoices.pay.mockResolvedValue({ id: 'in_1', status: 'paid', total: 10500 });
  stripeMock.invoices.sendInvoice.mockResolvedValue({ id: 'in_1', status: 'paid' });
});

describe('createOrderInvoice', () => {
  it('attaches items directly to a send_invoice PLN draft, pays out-of-band, then sends', async () => {
    await createOrderInvoice('pi_1');

    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_method: 'send_invoice',
        currency: 'pln',
        auto_advance: false,
      }),
      expect.objectContaining({ idempotencyKey: 'inv2_ord-1' }),
    );
    // Both the piece and the shipping line attach to the invoice itself.
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledTimes(2);
    for (const call of stripeMock.invoiceItems.create.mock.calls) {
      expect(call[0]).toMatchObject({ invoice: 'in_1', currency: 'pln' });
    }
    expect(stripeMock.invoices.finalizeInvoice).toHaveBeenCalledOnce();
    expect(stripeMock.invoices.pay).toHaveBeenCalledWith(
      'in_1',
      expect.objectContaining({ paid_out_of_band: true }),
      expect.anything(),
    );
    // send happens AFTER pay — allowed for send_invoice collection.
    const payOrder = stripeMock.invoices.pay.mock.invocationCallOrder[0];
    const sendOrder = stripeMock.invoices.sendInvoice.mock.invocationCallOrder[0];
    expect(sendOrder).toBeGreaterThan(payOrder);
    expect(updateEq).toHaveBeenCalled();
  });

  it('throws before finalizing when the draft total drifts from the order total', async () => {
    stripeMock.invoices.retrieve.mockReset();
    stripeMock.invoices.retrieve
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 0 })
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 9999 });

    await expect(createOrderInvoice('pi_1')).rejects.toThrow(/total 9999 != order ord-1 total 10500/);
    expect(stripeMock.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(updateEq).not.toHaveBeenCalled();
  });

  it('resumes idempotently when a webhook retry finds the invoice already paid', async () => {
    // invoices.create replays the original draft snapshot; live retrieve says paid.
    stripeMock.invoices.retrieve.mockReset();
    stripeMock.invoices.retrieve.mockResolvedValueOnce({ id: 'in_1', status: 'paid', total: 10500 });

    await createOrderInvoice('pi_1');

    expect(stripeMock.invoiceItems.create).not.toHaveBeenCalled();
    expect(stripeMock.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(stripeMock.invoices.pay).not.toHaveBeenCalled();
    expect(stripeMock.invoices.sendInvoice).toHaveBeenCalledOnce(); // Stripe-side idempotency key dedupes
    expect(updateEq).toHaveBeenCalled();
  });

  it('skips orders that are unpaid or already invoiced', async () => {
    orderRow = { ...ORDER, invoiced_at: '2026-06-05T00:00:00Z' };
    await createOrderInvoice('pi_1');
    expect(stripeMock.customers.create).not.toHaveBeenCalled();

    orderRow = { ...ORDER, status: 'pending' };
    await createOrderInvoice('pi_1');
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('reuses an existing Stripe customer when one is found by email', async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [{ id: 'cus_existing' }] });

    await createOrderInvoice('pi_1');

    expect(stripeMock.customers.list).toHaveBeenCalledWith({
      email: ORDER.email,
      limit: 1,
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing' }),
      expect.anything(),
    );
  });

  it('throws when the invoice lands in an unexpected status', async () => {
    stripeMock.invoices.retrieve.mockReset();
    stripeMock.invoices.retrieve.mockResolvedValueOnce({ id: 'in_1', status: 'void', total: 0 });

    await expect(createOrderInvoice('pi_1')).rejects.toThrow(/unexpected status void/);
    expect(stripeMock.invoices.sendInvoice).not.toHaveBeenCalled();
  });

  it('uses EUR currency for invoice and items when order.currency is eur', async () => {
    const eurOrder = { ...ORDER, currency: 'eur', subtotal: 2200, shipping: 500, total: 2700 };
    orderRow = eurOrder;
    stripeMock.invoices.retrieve.mockReset();
    stripeMock.invoices.retrieve
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 0 })
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 2700 });
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({ id: 'in_1', status: 'open', total: 2700 });
    stripeMock.invoices.pay.mockResolvedValue({ id: 'in_1', status: 'paid', total: 2700 });

    await createOrderInvoice('pi_1');

    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'eur' }),
      expect.anything(),
    );
    for (const call of stripeMock.invoiceItems.create.mock.calls) {
      expect(call[0]).toMatchObject({ currency: 'eur' });
    }
  });

  it('uses en preferred_locales when order.locale is en', async () => {
    orderRow = { ...ORDER, locale: 'en', currency: 'eur' };
    await createOrderInvoice('pi_1');
    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_locales: ['en'] }),
      expect.anything(),
    );
  });

  it('updates shipping on reused customer when shipping address is present', async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [{ id: 'cus_existing' }] });
    stripeMock.customers.update.mockResolvedValue({ id: 'cus_existing' });
    orderRow = {
      ...ORDER,
      shipping_address: { street: 'Nowa', building_number: '1', city: 'Warsaw', post_code: '00-001', country_code: 'PL' },
    };
    await createOrderInvoice('pi_1');
    expect(stripeMock.customers.update).toHaveBeenCalledWith(
      'cus_existing',
      expect.objectContaining({
        shipping: expect.objectContaining({ address: expect.objectContaining({ city: 'Warsaw' }) }),
        preferred_locales: ['pl'],
      }),
    );
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('uses English product labels and shipping description for en locale', async () => {
    orderRow = { ...ORDER, locale: 'en', currency: 'eur' };
    await createOrderInvoice('pi_1');
    const itemCall = stripeMock.invoiceItems.create.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).description !== 'Shipping — Paczkomat InPost'
    );
    expect(itemCall?.[0]).toMatchObject({ description: expect.stringMatching(/^Mug Nº/) });
    const shippingCall = stripeMock.invoiceItems.create.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).description === 'Shipping — Paczkomat InPost'
    );
    expect(shippingCall).toBeDefined();
  });
});
