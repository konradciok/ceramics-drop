import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShipxApiError } from '@/lib/shipx-errors';

const mocks = vi.hoisted(() => ({
  cancelPrintFulfilment: vi.fn(),
  emailOrderConfirmationToCustomer: vi.fn(),
  createOrderShipment: vi.fn(),
  releaseReservedPieces: vi.fn(),
  claimExpiryLease: vi.fn(),
  releaseExpiryLease: vi.fn(),
  expirePendingFenced: vi.fn(),
}));

vi.mock('@/server/fulfilment/cancel-print', () => ({ cancelPrintFulfilment: mocks.cancelPrintFulfilment }));
vi.mock('@/lib/email', () => ({ emailOrderConfirmationToCustomer: mocks.emailOrderConfirmationToCustomer }));
vi.mock('@/lib/shipment', () => ({ createOrderShipment: mocks.createOrderShipment }));
vi.mock('@/lib/piece-release', () => ({ releaseReservedPieces: mocks.releaseReservedPieces }));
vi.mock('@/lib/expire-orders', () => ({
  claimExpiryLease: mocks.claimExpiryLease,
  releaseExpiryLease: mocks.releaseExpiryLease,
  expirePendingFenced: mocks.expirePendingFenced,
}));

import { refundOrder, releaseReservation, resendOrderConfirmation, createShipmentForOrder } from './actions';

const ORDER_ID = '00000000-0000-0000-0000-000000000001';
const ENV = { fake: 'env' } as unknown as CloudflareEnv;

/** Minimal `.from(table).select(...).eq(...).maybeSingle()` chain for a single-row read. */
function supabaseForOrder(
  order: Record<string, unknown> | null,
  readError: { message: string } | null = null,
  updateResult: { data: unknown; error: { message: string } | null } = { data: [], error: null },
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: order, error: readError });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  // UPDATE chains resolve at any `.eq()` depth and record every filter, so
  // tests can assert the fenced terminal CAS (`.eq('expiry_claim_at', token)`).
  const updateFilters: Array<[string, unknown[]]> = [];
  const updateNode: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(updateResult).then(resolve, reject),
  };
  updateNode.eq = (...args: unknown[]) => {
    updateFilters.push(['eq', args]);
    return updateNode;
  };
  const update = vi.fn(() => updateNode);
  return { from: vi.fn(() => ({ select, update })), update, updateFilters };
}

describe('refundOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stripeWith(create: ReturnType<typeof vi.fn>) {
    return { refunds: { create } } as unknown as import('stripe').default;
  }

  it('refunds a ceramic order, then stops print fulfilment (in that order)', async () => {
    const supabase = supabaseForOrder({ payment_intent_id: 'pi_1', status: 'paid' });
    const refundsCreate = vi.fn().mockResolvedValue({ id: 're_1' });
    mocks.cancelPrintFulfilment.mockResolvedValue('no_print_items');

    const result = await refundOrder(
      { supabase: supabase as never, stripe: stripeWith(refundsCreate), env: ENV },
      ORDER_ID,
    );

    expect(result).toEqual({
      status: 200,
      body: { message: 'Zwrot utworzony (re_1). Status zaktualizuje webhook.', printFulfilment: 'no_print_items' },
    });
    expect(refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_1' },
      { idempotencyKey: 'admin_refund_pi_1' },
    );
    expect(mocks.cancelPrintFulfilment).toHaveBeenCalledWith(ORDER_ID, ENV);
    expect(mocks.cancelPrintFulfilment.mock.invocationCallOrder[0]).toBeGreaterThan(
      refundsCreate.mock.invocationCallOrder[0],
    );
  });

  it('surfaces a manual_cancel_required print outcome so a caller can flag it for follow-up', async () => {
    const supabase = supabaseForOrder({ payment_intent_id: 'pi_1', status: 'paid' });
    const refundsCreate = vi.fn().mockResolvedValue({ id: 're_1' });
    mocks.cancelPrintFulfilment.mockResolvedValue('manual_cancel_required');

    const result = await refundOrder(
      { supabase: supabase as never, stripe: stripeWith(refundsCreate), env: ENV },
      ORDER_ID,
    );

    expect(result.body).toMatchObject({ printFulfilment: 'manual_cancel_required' });
  });

  it('a Stripe refund failure returns 502 and never touches fulfilment', async () => {
    const supabase = supabaseForOrder({ payment_intent_id: 'pi_1', status: 'paid' });
    const refundsCreate = vi.fn().mockRejectedValue(new Error('stripe down'));

    const result = await refundOrder(
      { supabase: supabase as never, stripe: stripeWith(refundsCreate), env: ENV },
      ORDER_ID,
    );

    expect(result).toEqual({ status: 502, body: { error: 'stripe down' } });
    expect(mocks.cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('returns 409 for a non-paid order without creating a refund', async () => {
    const supabase = supabaseForOrder({ payment_intent_id: 'pi_1', status: 'refunded' });
    const refundsCreate = vi.fn();

    const result = await refundOrder(
      { supabase: supabase as never, stripe: stripeWith(refundsCreate), env: ENV },
      ORDER_ID,
    );

    expect(result.status).toBe(409);
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(mocks.cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('returns 404 when the order does not exist', async () => {
    const supabase = supabaseForOrder(null);
    const result = await refundOrder(
      { supabase: supabase as never, stripe: stripeWith(vi.fn()), env: ENV },
      ORDER_ID,
    );
    expect(result).toEqual({ status: 404, body: { error: 'Order not found' } });
  });

  it('returns 409 when the order has no PaymentIntent', async () => {
    const supabase = supabaseForOrder({ payment_intent_id: null, status: 'paid' });
    const result = await refundOrder(
      { supabase: supabase as never, stripe: stripeWith(vi.fn()), env: ENV },
      ORDER_ID,
    );
    expect(result).toEqual({ status: 409, body: { error: 'Brak PaymentIntent dla zamówienia.' } });
  });

  it('returns 500 on a Supabase read failure', async () => {
    const supabase = supabaseForOrder(null, { message: 'db down' });
    const result = await refundOrder(
      { supabase: supabase as never, stripe: stripeWith(vi.fn()), env: ENV },
      ORDER_ID,
    );
    expect(result).toEqual({ status: 500, body: { error: 'db down' } });
  });
});

describe('releaseReservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the expiry lease is granted; individual tests deny it.
    mocks.claimExpiryLease.mockResolvedValue('claim-1');
    mocks.releaseExpiryLease.mockResolvedValue(undefined);
    mocks.expirePendingFenced.mockResolvedValue({ expired: true, error: null });
  });

  function stripeWith(cancel: ReturnType<typeof vi.fn>, retrieve: ReturnType<typeof vi.fn> = vi.fn()) {
    return { paymentIntents: { cancel, retrieve } } as unknown as import('stripe').default;
  }

  it('returns 409 for an already-paid order', async () => {
    const supabase = supabaseForOrder({ status: 'paid', private_sale_id: null, payment_intent_id: 'pi_1' });
    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(vi.fn()) }, ORDER_ID);
    expect(result).toEqual({ status: 409, body: { error: 'Zamówienie opłacone — użyj zwrotu, nie zwalniaj rezerwacji.' } });
    expect(mocks.releaseReservedPieces).not.toHaveBeenCalled();
    expect(mocks.claimExpiryLease).not.toHaveBeenCalled();
  });

  it('returns 409 when the PaymentIntent turns out to be paid/processing — and hands its lease back', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: null, payment_intent_id: 'pi_1' });
    const cancel = vi.fn().mockRejectedValue(new Error('cannot cancel'));
    const retrieve = vi.fn().mockResolvedValue({ status: 'succeeded' });
    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel, retrieve) }, ORDER_ID);
    expect(result.status).toBe(409);
    expect(mocks.releaseReservedPieces).not.toHaveBeenCalled();
    expect(mocks.releaseExpiryLease).toHaveBeenCalledWith(supabase, ORDER_ID, 'claim-1');
  });

  it('returns 502 when Stripe cancellation errors out entirely — and hands its lease back', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: null, payment_intent_id: 'pi_1' });
    const cancel = vi.fn().mockRejectedValue(new Error('cannot cancel'));
    const retrieve = vi.fn().mockRejectedValue(new Error('cannot retrieve'));
    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel, retrieve) }, ORDER_ID);
    expect(result).toEqual({ status: 502, body: { error: 'Nie udało się anulować PaymentIntent w Stripe.' } });
    expect(mocks.releaseExpiryLease).toHaveBeenCalledWith(supabase, ORDER_ID, 'claim-1');
  });

  it('cancels the PI, frees pieces, and expires a pending order via the shared lease-fenced CAS', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: null, payment_intent_id: 'pi_1' });
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.releaseReservedPieces.mockResolvedValue(['k01', 'k02']);

    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel) }, ORDER_ID);

    expect(result).toEqual({ status: 200, body: { message: 'Zwolniono 2 prac(e).' } });
    expect(cancel).toHaveBeenCalledWith('pi_1');
    // Terminal write goes through the SHARED fenced CAS (single definition
    // with the cron's finalizeExpiry — its payload + predicates are pinned in
    // expire-orders.test.ts), scoped to OUR claim token (M-5 / d4).
    expect(mocks.expirePendingFenced).toHaveBeenCalledWith(supabase, ORDER_ID, 'claim-1');
  });

  // M-5 pending-consumer guard: the claim happens AFTER the initial read, so a
  // refund-pending marker that landed in between still denies the claim — the
  // interleaving a predicate on the final update alone would miss.
  it('claim denied (refund-pending or concurrently claimed): 409, PI cancel and piece release never run', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: null, payment_intent_id: 'pi_1' });
    const cancel = vi.fn();
    mocks.claimExpiryLease.mockResolvedValue(null);

    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel) }, ORDER_ID);

    expect(result.status).toBe(409);
    expect(cancel).not.toHaveBeenCalled();
    expect(mocks.releaseReservedPieces).not.toHaveBeenCalled();
    expect(supabase.update).not.toHaveBeenCalled();
  });

  it('takes the claim BEFORE cancelling the PaymentIntent (the irreversible mutation)', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: null, payment_intent_id: 'pi_1' });
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.releaseReservedPieces.mockResolvedValue([]);

    await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel) }, ORDER_ID);

    expect(mocks.claimExpiryLease.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]);
  });

  // Recovery (plan c3): a piece-release failure after the claim leaves the
  // order pending AND returns the lease, so an immediate admin retry completes.
  it('piece-release failure after the claim: 500, order stays pending, lease handed back — the retry completes', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: null, payment_intent_id: 'pi_1' });
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.releaseReservedPieces.mockRejectedValueOnce(new Error('piece_state locked'));

    const first = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel) }, ORDER_ID);
    expect(first).toEqual({ status: 500, body: { error: 'piece_state locked' } });
    expect(supabase.update).not.toHaveBeenCalled(); // never terminal on failure
    expect(mocks.releaseExpiryLease).toHaveBeenCalledWith(supabase, ORDER_ID, 'claim-1');

    mocks.releaseReservedPieces.mockResolvedValueOnce(['k01']);
    const second = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel) }, ORDER_ID);
    expect(second).toEqual({ status: 200, body: { message: 'Zwolniono 1 prac(e).' } });
  });

  it('terminal-CAS DB error after the claim: 500 AND the lease is handed back (immediate retry unblocked)', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: null, payment_intent_id: 'pi_1' });
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.releaseReservedPieces.mockResolvedValue(['k01']);
    mocks.expirePendingFenced.mockResolvedValueOnce({ expired: false, error: 'orders down' });

    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel) }, ORDER_ID);

    expect(result).toEqual({ status: 500, body: { error: 'orders down' } });
    // Without the hand-back, claimExpiryLease 409-blocks the promised
    // immediate retry for the full 10-min lease TTL.
    expect(mocks.releaseExpiryLease).toHaveBeenCalledWith(supabase, ORDER_ID, 'claim-1');
  });

  it('non-pending orders skip the claim entirely (no PI cancel, no expiry) and just free stuck pieces', async () => {
    const supabase = supabaseForOrder({ status: 'expired', private_sale_id: null, payment_intent_id: null });
    mocks.releaseReservedPieces.mockResolvedValue(['k01']);

    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(vi.fn()) }, ORDER_ID);

    expect(result.status).toBe(200);
    expect(mocks.claimExpiryLease).not.toHaveBeenCalled();
    expect(supabase.update).not.toHaveBeenCalled();
  });

  it('forwards the private_sale_id so freed pieces return to sold, not available', async () => {
    const supabase = supabaseForOrder({ status: 'pending', private_sale_id: 'ps_1', payment_intent_id: 'pi_1' });
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.releaseReservedPieces.mockResolvedValue(['k03']);

    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(cancel) }, ORDER_ID);

    expect(result).toEqual({ status: 200, body: { message: 'Zwolniono 1 prac(e).' } });
    expect(mocks.releaseReservedPieces).toHaveBeenCalledWith(supabase, { id: ORDER_ID, private_sale_id: 'ps_1' });
  });

  it('reports no pieces to free without touching order status', async () => {
    const supabase = supabaseForOrder({ status: 'failed', private_sale_id: null, payment_intent_id: null });
    mocks.releaseReservedPieces.mockResolvedValue([]);

    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(vi.fn()) }, ORDER_ID);

    expect(result).toEqual({ status: 200, body: { message: 'Brak zarezerwowanych prac do zwolnienia.' } });
    expect(supabase.update).not.toHaveBeenCalled();
  });

  it('surfaces a release failure as 500', async () => {
    const supabase = supabaseForOrder({ status: 'failed', private_sale_id: null, payment_intent_id: null });
    mocks.releaseReservedPieces.mockRejectedValue(new Error('piece_state locked'));

    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(vi.fn()) }, ORDER_ID);

    expect(result).toEqual({ status: 500, body: { error: 'piece_state locked' } });
  });

  it('returns 404 when the order does not exist', async () => {
    const supabase = supabaseForOrder(null);
    const result = await releaseReservation({ supabase: supabase as never, stripe: stripeWith(vi.fn()) }, ORDER_ID);
    expect(result).toEqual({ status: 404, body: { error: 'Order not found' } });
  });
});

describe('resendOrderConfirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the confirmation email and reports the recipient', async () => {
    const supabase = supabaseForOrder({ id: ORDER_ID, email: 'buyer@example.com', receiver_first_name: 'Ada', locale: 'en' });
    mocks.emailOrderConfirmationToCustomer.mockResolvedValue(undefined);

    const result = await resendOrderConfirmation({ supabase: supabase as never, env: ENV }, ORDER_ID);

    expect(result).toEqual({ status: 200, body: { message: 'Potwierdzenie wysłane ponownie na buyer@example.com.' } });
    expect(mocks.emailOrderConfirmationToCustomer).toHaveBeenCalledWith({
      order: { id: ORDER_ID, email: 'buyer@example.com', receiver_first_name: 'Ada' },
      locale: 'en',
      env: ENV,
    });
  });

  it('defaults the locale to pl when the order has none', async () => {
    const supabase = supabaseForOrder({ id: ORDER_ID, email: 'buyer@example.com', receiver_first_name: null, locale: null });
    mocks.emailOrderConfirmationToCustomer.mockResolvedValue(undefined);

    await resendOrderConfirmation({ supabase: supabase as never, env: ENV }, ORDER_ID);

    expect(mocks.emailOrderConfirmationToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'pl' }),
    );
  });

  it('returns 409 when the order has no email on file', async () => {
    const supabase = supabaseForOrder({ id: ORDER_ID, email: null, receiver_first_name: null, locale: 'pl' });
    const result = await resendOrderConfirmation({ supabase: supabase as never, env: ENV }, ORDER_ID);
    expect(result).toEqual({ status: 409, body: { error: 'Zamówienie nie ma adresu e-mail.' } });
    expect(mocks.emailOrderConfirmationToCustomer).not.toHaveBeenCalled();
  });

  it('returns 502 when Resend fails', async () => {
    const supabase = supabaseForOrder({ id: ORDER_ID, email: 'buyer@example.com', receiver_first_name: null, locale: 'pl' });
    mocks.emailOrderConfirmationToCustomer.mockRejectedValue(new Error('resend down'));
    const result = await resendOrderConfirmation({ supabase: supabase as never, env: ENV }, ORDER_ID);
    expect(result).toEqual({ status: 502, body: { error: 'resend down' } });
  });

  it('returns 404 when the order does not exist', async () => {
    const supabase = supabaseForOrder(null);
    const result = await resendOrderConfirmation({ supabase: supabase as never, env: ENV }, ORDER_ID);
    expect(result).toEqual({ status: 404, body: { error: 'Order not found' } });
  });
});

describe('createShipmentForOrder', () => {
  const inpost = {} as never;

  function supabaseForShipment(
    order: Record<string, unknown> | null,
    ceramicCount: number | { count: null; error: { message: string } } = 1,
  ) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: order, error: null });
    const eqOrders = vi.fn(() => ({ maybeSingle }));
    const selectOrders = vi.fn(() => ({ eq: eqOrders }));

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq: updateEq }));

    const countResult =
      typeof ceramicCount === 'number' ? { count: ceramicCount, error: null } : ceramicCount;
    const isNull = vi.fn().mockResolvedValue(countResult);
    const eqItems = vi.fn(() => ({ is: isNull }));
    const selectItems = vi.fn(() => ({ eq: eqItems }));
    const from = vi.fn((table: string) => {
      if (table === 'order_items') return { select: selectItems };
      return { select: selectOrders, update };
    });
    return { from, update, updateEq };
  }

  function adminOrder(overrides: Record<string, unknown> = {}) {
    return {
      payment_intent_id: 'pi_1',
      status: 'paid',
      delivery_method: 'paczkomat',
      inpost_shipment_id: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOrderShipment.mockResolvedValue(undefined);
  });

  it('creates a shipment for a paid order', async () => {
    const supabase = supabaseForShipment(adminOrder());
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result).toEqual({ status: 200, body: { message: 'Przesyłka utworzona.' } });
    expect(mocks.createOrderShipment).toHaveBeenCalledWith(
      'pi_1',
      expect.objectContaining({ inpost }),
      undefined,
    );
  });

  it('returns idempotent success when a shipment already exists', async () => {
    const supabase = supabaseForShipment(adminOrder({ inpost_shipment_id: '42' }));
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result).toEqual({ status: 200, body: { message: 'Przesyłka już istnieje.' } });
  });

  it('returns 409 when the order is not paid', async () => {
    const supabase = supabaseForShipment(adminOrder({ status: 'pending' }));
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result.status).toBe(409);
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('returns 409 for studio pickup', async () => {
    const supabase = supabaseForShipment(adminOrder({ delivery_method: 'odbior' }));
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result).toEqual({ status: 409, body: { error: 'Odbiór osobisty nie wymaga przesyłki.' } });
  });

  it('returns 409 for a print-only order and never calls InPost', async () => {
    const supabase = supabaseForShipment(adminOrder({ delivery_method: 'kurier' }), 0);
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toContain('Prodigi');
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('recreates a shipment when recreate is true', async () => {
    const supabase = supabaseForShipment(adminOrder({ inpost_shipment_id: '42' }));
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID, { recreate: true });
    expect(result).toEqual({ status: 200, body: { message: 'Nowa przesyłka utworzona.' } });
    expect(supabase.update).toHaveBeenCalledWith({
      inpost_shipment_id: null,
      inpost_tracking_number: null,
      inpost_dispatch_order_id: null,
      delivery_status: null,
      inpost_label_emailed_at: null,
    });
    expect(mocks.createOrderShipment).toHaveBeenCalledWith('pi_1', expect.any(Object), { adoptExisting: false });
  });

  it('returns 409 when recreate is requested without an existing shipment', async () => {
    const supabase = supabaseForShipment(adminOrder());
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID, { recreate: true });
    expect(result).toEqual({ status: 409, body: { error: 'Brak przesyłki do zastąpienia.' } });
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('surfaces shipment creation failures as 502', async () => {
    const supabase = supabaseForShipment(adminOrder());
    mocks.createOrderShipment.mockRejectedValueOnce(new Error('ShipX unavailable'));
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result).toEqual({ status: 502, body: { error: 'ShipX unavailable' } });
  });

  it('translates an offer_expired ShipxApiError into a friendly message', async () => {
    const supabase = supabaseForShipment(adminOrder());
    mocks.createOrderShipment.mockRejectedValueOnce(new ShipxApiError('POST', '/v1/shipments/1/buy', 400, JSON.stringify({ error: 'offer_expired' })));
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result).toEqual({ status: 502, body: { error: 'Oferta wygasła — użyj „Utwórz nową przesyłkę”.' } });
  });

  it('returns 500 when the ceramic count query fails', async () => {
    const supabase = supabaseForShipment(adminOrder(), { count: null, error: { message: 'db down' } });
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result).toEqual({ status: 500, body: { error: 'db down' } });
    expect(mocks.createOrderShipment).not.toHaveBeenCalled();
  });

  it('returns 404 when the order does not exist', async () => {
    const supabase = supabaseForShipment(null);
    const result = await createShipmentForOrder({ supabase: supabase as never, inpost }, ORDER_ID);
    expect(result).toEqual({ status: 404, body: { error: 'Order not found' } });
  });
});
