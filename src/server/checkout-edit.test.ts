import { describe, it, expect, vi } from 'vitest';
import { editCheckout, type CheckoutEditDeps, type EditableOrder } from './checkout-edit';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const NEXT_ID = '22222222-2222-4222-8222-222222222222';
const PI = 'pi_3Abc';
const SECRET = `${PI}_secret_XyZ123`;

const order = (over: Partial<EditableOrder> = {}): EditableOrder => ({
  id: ORDER_ID,
  status: 'pending',
  payment_intent_id: PI,
  private_sale_id: null,
  gift_card_id: null,
  promo_code: null,
  ...over,
});

function deps(over: Partial<CheckoutEditDeps> = {}) {
  const calls: string[] = [];
  const d: CheckoutEditDeps = {
    loadOrder: vi.fn(async () => order()),
    retrieveIntent: vi.fn(async () => ({ clientSecret: SECRET, orderId: ORDER_ID, status: 'requires_payment_method' })),
    claimLease: vi.fn(async () => { calls.push('claim'); return 'tok'; }),
    releaseLease: vi.fn(async () => { calls.push('release'); }),
    transferHold: vi.fn(async () => { calls.push('transfer out'); return 2; }),
    restoreHold: vi.fn(async () => { calls.push('transfer back'); return 2; }),
    cancelIntent: vi.fn(async () => { calls.push('cancel'); return 'canceled' as const; }),
    finalize: vi.fn(async () => { calls.push('finalize'); }),
    log: vi.fn(),
    ...over,
  };
  return { d, calls };
}

const body = { orderId: ORDER_ID, clientSecret: SECRET, nextAttemptId: NEXT_ID };

describe('editCheckout', () => {
  it('moves the hold BEFORE cancelling, then expires the old order', async () => {
    const { d, calls } = deps();
    const res = await editCheckout(body, d);
    expect(res).toEqual({ status: 200, body: { ok: true, transferred: 2 } });
    expect(calls).toEqual(['claim', 'transfer out', 'cancel', 'finalize']);
    expect(d.transferHold).toHaveBeenCalledWith(ORDER_ID, NEXT_ID);
    expect(d.cancelIntent).toHaveBeenCalledWith(PI);
  });

  it.each([
    ['a missing body', null],
    ['a malformed order id', { ...body, orderId: 'nope' }],
    ['a malformed next attempt id', { ...body, nextAttemptId: 'nope' }],
    ['the same id twice', { ...body, nextAttemptId: ORDER_ID }],
    ['a value that is not a client secret', { ...body, clientSecret: 'pi_3Abc' }],
  ])('refuses %s with 400 and touches nothing', async (_label, input) => {
    const { d } = deps();
    expect(await editCheckout(input, d)).toEqual({ status: 400, body: { error: 'bad_request' } });
    expect(d.loadOrder).not.toHaveBeenCalled();
  });

  it('answers 403 for an unknown order', async () => {
    const { d } = deps({ loadOrder: vi.fn(async () => null) });
    expect(await editCheckout(body, d)).toEqual({ status: 403, body: { error: 'forbidden' } });
  });

  it('answers 403 when the secret belongs to another PaymentIntent', async () => {
    const { d } = deps({ loadOrder: vi.fn(async () => order({ payment_intent_id: 'pi_other' })) });
    expect(await editCheckout(body, d)).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(d.retrieveIntent).not.toHaveBeenCalled();
  });

  it('answers 403 when the secret does not match Stripe\'s', async () => {
    const { d } = deps({ retrieveIntent: vi.fn(async () => ({ clientSecret: `${PI}_secret_other1`, orderId: ORDER_ID, status: 'requires_payment_method' })) });
    expect(await editCheckout(body, d)).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(d.claimLease).not.toHaveBeenCalled();
  });

  it('answers 403 when the PaymentIntent is another order\'s', async () => {
    const { d } = deps({ retrieveIntent: vi.fn(async () => ({ clientSecret: SECRET, orderId: NEXT_ID, status: 'requires_payment_method' })) });
    expect(await editCheckout(body, d)).toEqual({ status: 403, body: { error: 'forbidden' } });
  });

  it.each([
    ['a gift-card balance order', { gift_card_id: 'gc_1' }],
    ['a private-sale order', { private_sale_id: 'ps_1' }],
  ])('refuses %s (v1 scope)', async (_label, over) => {
    const { d } = deps({ loadOrder: vi.fn(async () => order(over)) });
    expect(await editCheckout(body, d)).toEqual({ status: 409, body: { error: 'edit_unsupported' } });
    expect(d.claimLease).not.toHaveBeenCalled();
  });

  it('refuses an order that is no longer pending', async () => {
    const { d } = deps({ loadOrder: vi.fn(async () => order({ status: 'paid' })) });
    expect(await editCheckout(body, d)).toEqual({ status: 409, body: { error: 'order_not_pending' } });
  });

  it.each(['processing', 'requires_action', 'succeeded', 'requires_capture'])(
    'refuses while a payment is under way (%s), before touching the hold',
    async (status) => {
      const { d } = deps({ retrieveIntent: vi.fn(async () => ({ clientSecret: SECRET, orderId: ORDER_ID, status })) });
      expect(await editCheckout(body, d)).toEqual({ status: 409, body: { error: 'payment_in_progress' } });
      expect(d.claimLease).not.toHaveBeenCalled();
      expect(d.transferHold).not.toHaveBeenCalled();
    },
  );

  it('treats an already-cancelled PaymentIntent as an order with nothing left to pay', async () => {
    const { d } = deps({ retrieveIntent: vi.fn(async () => ({ clientSecret: SECRET, orderId: ORDER_ID, status: 'canceled' })) });
    expect(await editCheckout(body, d)).toEqual({ status: 409, body: { error: 'order_not_pending' } });
    expect(d.transferHold).not.toHaveBeenCalled();
  });

  it('backs off when another consumer holds the order', async () => {
    const { d } = deps({ claimLease: vi.fn(async () => null) });
    expect(await editCheckout(body, d)).toEqual({ status: 409, body: { error: 'checkout_in_progress' } });
    expect(d.transferHold).not.toHaveBeenCalled();
    expect(d.cancelIntent).not.toHaveBeenCalled();
  });

  it('releases the lease and cancels nothing when the transfer fails', async () => {
    const { d, calls } = deps({ transferHold: vi.fn(async () => { throw new Error('db down'); }) });
    expect(await editCheckout(body, d)).toEqual({ status: 503, body: { error: 'edit_failed' } });
    expect(calls).toEqual(['claim', 'release']);
    expect(d.cancelIntent).not.toHaveBeenCalled();
  });

  it('moves the hold back when the buyer is already paying', async () => {
    const { d, calls } = deps({ cancelIntent: vi.fn(async () => { calls.push('cancel'); return 'paid' as const; }) });
    expect(await editCheckout(body, d)).toEqual({ status: 409, body: { error: 'payment_in_progress' } });
    expect(calls).toEqual(['claim', 'transfer out', 'cancel', 'transfer back', 'release']);
    expect(d.restoreHold).toHaveBeenCalledWith(NEXT_ID, ORDER_ID);
    expect(d.finalize).not.toHaveBeenCalled();
  });

  it('moves the hold back on a transient Stripe error', async () => {
    const { d, calls } = deps({ cancelIntent: vi.fn(async () => { calls.push('cancel'); return 'error' as const; }) });
    expect(await editCheckout(body, d)).toEqual({ status: 503, body: { error: 'edit_failed' } });
    expect(calls).toEqual(['claim', 'transfer out', 'cancel', 'transfer back', 'release']);
  });

  it('retries a failed restore once before giving up', async () => {
    let tries = 0;
    const { d, calls } = deps({
      cancelIntent: vi.fn(async () => { calls.push('cancel'); return 'error' as const; }),
      restoreHold: vi.fn(async () => {
        tries += 1;
        calls.push('transfer back');
        if (tries === 1) throw new Error('db blip');
        return 2;
      }),
    });
    expect(await editCheckout(body, d)).toEqual({ status: 503, body: { error: 'edit_failed' } });
    expect(calls).toEqual(['claim', 'transfer out', 'cancel', 'transfer back', 'transfer back', 'release']);
    expect(d.log).not.toHaveBeenCalled();
  });

  it('alerts and still releases the lease when both restore tries fail', async () => {
    const { d, calls } = deps({
      cancelIntent: vi.fn(async () => { calls.push('cancel'); return 'paid' as const; }),
      restoreHold: vi.fn(async () => { calls.push('transfer back'); throw new Error('db down'); }),
    });
    expect(await editCheckout(body, d)).toEqual({ status: 409, body: { error: 'payment_in_progress' } });
    expect(calls).toEqual(['claim', 'transfer out', 'cancel', 'transfer back', 'transfer back', 'release']);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledWith('checkout_edit_restore_failed', expect.objectContaining({ orderId: ORDER_ID, nextAttemptId: NEXT_ID }));
  });

  it('answers 503 (not 403) and alerts when Stripe cannot be reached for the lookup', async () => {
    const { d } = deps({ retrieveIntent: vi.fn(async () => { throw new Error('ETIMEDOUT'); }) });
    expect(await editCheckout(body, d)).toEqual({ status: 503, body: { error: 'edit_failed' } });
    expect(d.log).toHaveBeenCalledWith('checkout_edit_intent_lookup_failed', expect.objectContaining({ orderId: ORDER_ID }));
    expect(d.claimLease).not.toHaveBeenCalled();
  });

  it('still succeeds when expiring the old order fails after the cancel (the sweep converges it)', async () => {
    const { d } = deps({ finalize: vi.fn(async () => { throw new Error('db down'); }) });
    expect(await editCheckout(body, d)).toEqual({ status: 200, body: { ok: true, transferred: 2 } });
    expect(d.log).toHaveBeenCalledWith('checkout_edit_finalize_failed', expect.objectContaining({ orderId: ORDER_ID }));
  });
});
