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

  it('adds a negative discount line labeled with the promo code so the invoice total equals the charged amount', async () => {
    orderRow = { ...ORDER, promo_code: 'WELCOME10', discount: 900, total: 10100 };
    stripeMock.invoices.retrieve.mockReset();
    stripeMock.invoices.retrieve
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 0 })
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 10100 });
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({ id: 'in_1', status: 'open', total: 10100 });
    stripeMock.invoices.pay.mockResolvedValue({ id: 'in_1', status: 'paid', total: 10100 });

    await createOrderInvoice('pi_1');

    // item + shipping + discount
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledTimes(3);
    const discountCall = stripeMock.invoiceItems.create.mock.calls.find(
      (c) => (c[0] as { amount: number }).amount < 0,
    );
    expect(discountCall).toBeDefined();
    expect(discountCall![0]).toMatchObject({
      invoice: 'in_1',
      currency: 'pln',
      amount: -900,
      description: 'Rabat (WELCOME10)',
    });
    expect(discountCall![1]).toMatchObject({ idempotencyKey: 'ii2_ord-1_discount' });
    expect(stripeMock.invoices.sendInvoice).toHaveBeenCalled();
  });

  it('uses the English discount label for en-locale orders', async () => {
    orderRow = { ...ORDER, locale: 'en', promo_code: 'WELCOME10', discount: 900, total: 10100 };
    stripeMock.invoices.retrieve.mockReset();
    stripeMock.invoices.retrieve
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 0 })
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 10100 });

    await createOrderInvoice('pi_1');

    const discountCall = stripeMock.invoiceItems.create.mock.calls.find(
      (c) => (c[0] as { amount: number }).amount < 0,
    );
    expect(discountCall![0]).toMatchObject({ description: 'Discount (WELCOME10)' });
  });

  it('adds no discount line when the order has no discount', async () => {
    await createOrderInvoice('pi_1');
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledTimes(2);
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
    expect(stripeMock.customers.update).toHaveBeenCalledWith(
      'cus_existing',
      expect.objectContaining({ preferred_locales: ['pl'] }),
    );
    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_updated' }),
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

  it('passes native print address lines to Stripe customer shipping', async () => {
    orderRow = {
      ...ORDER,
      shipping_address: {
        line1: '221B Baker Street', line2: 'Flat B', city: 'London', post_code: 'NW1', country_code: 'GB',
      },
    };
    await createOrderInvoice('pi_1');
    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping: expect.objectContaining({
          address: expect.objectContaining({ line1: '221B Baker Street', line2: 'Flat B', city: 'London' }),
        }),
      }),
      expect.anything(),
    );
  });

  it('gives two different designs in the same print variant distinct idempotency keys', async () => {
    // Regression: order 63445e00 (2026-09-02) had fap016 + fap008 both in
    // GLOBAL-FAP-28X40; a per-SKU key made Stripe reject the second item and
    // the draft invoice was stuck with one line.
    const variant = { size: '70x100', framed: false, mount: false, frameColour: 'none', prodigiSku: 'GLOBAL-FAP-28X40' };
    itemRows = [
      { order_id: 'ord-1', product_id: 'fap016', unit_price: 50500, variant },
      { order_id: 'ord-1', product_id: 'fap008', unit_price: 50500, variant },
    ];
    await createOrderInvoice('pi_1');
    const keys = stripeMock.invoiceItems.create.mock.calls
      .map((c: unknown[]) => (c[1] as { idempotencyKey: string }).idempotencyKey)
      .filter((k: string) => k !== 'ii2_ord-1_shipping');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('does not duplicate a line that a legacy draft already holds when a retry re-enters the draft branch', async () => {
    // A draft created before the key change already carries the first item
    // (under the old per-SKU key). The retry must skip that line by content,
    // add only the missing ones, and still pass the total guard.
    const variant = { size: '70x100', framed: false, mount: false, frameColour: 'none', prodigiSku: 'GLOBAL-FAP-28X40' };
    itemRows = [
      { order_id: 'ord-1', product_id: 'fap016', unit_price: 50500, variant },
      { order_id: 'ord-1', product_id: 'fap008', unit_price: 50500, variant },
    ];
    // First pass on a clean draft: learn the exact label the code emits for fap016.
    await createOrderInvoice('pi_1');
    const firstLabel = (stripeMock.invoiceItems.create.mock.calls[0][0] as { description: string }).description;

    vi.clearAllMocks();
    fromMode = 'select';
    stripeMock.customers.list.mockResolvedValue({ data: [] });
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_1' });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_1', status: 'draft', total: 50500 });
    stripeMock.invoiceItems.create.mockResolvedValue({ id: 'ii_2' });
    stripeMock.invoices.retrieve
      .mockResolvedValueOnce({
        id: 'in_1', status: 'draft', total: 50500,
        lines: { data: [{ id: 'il_legacy', description: firstLabel, amount: 50500 }] },
      })
      .mockResolvedValueOnce({ id: 'in_1', status: 'draft', total: 10500 });
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({ id: 'in_1', status: 'open', total: 10500 });
    stripeMock.invoices.pay.mockResolvedValue({ id: 'in_1', status: 'paid', total: 10500 });
    stripeMock.invoices.sendInvoice.mockResolvedValue({ id: 'in_1', status: 'paid' });
    updateEq.mockResolvedValue({ error: null });

    await createOrderInvoice('pi_1');
    const descriptions = stripeMock.invoiceItems.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { description: string }).description,
    );
    expect(descriptions).not.toContain(firstLabel);
    expect(descriptions).toHaveLength(2); // fap008 + shipping
    expect(stripeMock.invoices.finalizeInvoice).toHaveBeenCalled();
  });

  it('keeps two variants of the same design on distinct idempotency keys', async () => {
    const base = { size: '70x100', framed: false, mount: false, frameColour: 'none' };
    itemRows = [
      { order_id: 'ord-1', product_id: 'fap016', unit_price: 50500, variant: { ...base, prodigiSku: 'GLOBAL-FAP-28X40' } },
      { order_id: 'ord-1', product_id: 'fap016', unit_price: 30000, variant: { ...base, size: '50x70', prodigiSku: 'GLOBAL-FAP-20X28' } },
    ];
    await createOrderInvoice('pi_1');
    const keys = stripeMock.invoiceItems.create.mock.calls
      .map((c: unknown[]) => (c[1] as { idempotencyKey: string }).idempotencyKey)
      .filter((k: string) => k !== 'ii2_ord-1_shipping');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
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
