import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { handleBalancePaymentEvent, processBalanceIntent } from './balance-payment-events';
import { completePaidOrder } from './complete-paid-order';
import { finishBalanceRefund, reconcileBalanceRefunds } from './balance-refunds';

vi.mock('./complete-paid-order', () => ({ completePaidOrder: vi.fn(async () => true) }));
vi.mock('./balance-refunds', () => ({ finishBalanceRefund: vi.fn(async () => {}), reconcileBalanceRefunds: vi.fn(async () => {}) }));

function fixture() {
  const order = { id: 'o1', gift_card_id: 'card1', payment_intent_id: 'pi1', currency: 'eur', cash_amount: 2000, status: 'pending', refund_pending_at: null as string | null };
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: number; error: { message: string } | null }>>(async () => ({ data: 1000, error: null }));
  const from = vi.fn(() => {
    let update = false;
    const node = {
      select: () => node, eq: () => node, is: () => node,
      update: (patch: Record<string, unknown>) => { update = true; Object.assign(order, patch); return node; },
      maybeSingle: async () => ({ data: order, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: update ? [{ id: order.id }] : order, error: null }).then(resolve),
    };
    return node;
  });
  const intent = { id: 'pi1', amount: 2000, amount_received: 2000, currency: 'eur', status: 'succeeded', metadata: { gift_card_payment: '1', order_id: 'o1' } } as unknown as Stripe.PaymentIntent;
  const refunds = { list: vi.fn(async function* () {}), create: vi.fn(async () => ({ status: 'succeeded' })) };
  const stripe = { paymentIntents: { retrieve: vi.fn(async () => intent) }, refunds };
  const deps = { supabase: { from, rpc }, stripe, env: {}, ctx: {} } as never;
  return { order, intent, rpc, from, stripe, deps };
}

describe('balance payment lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());
  it('verifies cash, settles atomically, then reconciles refunds before fulfilment', async () => {
    const f = fixture();
    expect(await processBalanceIntent(f.intent, f.deps)).toBe(true);
    expect(f.rpc).toHaveBeenCalledWith('settle_gift_card', { p_order_id: 'o1', p_payment_intent_id: 'pi1', p_cash_received: 2000 });
    expect(vi.mocked(reconcileBalanceRefunds).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(completePaidOrder).mock.invocationCallOrder[0]);
  });
  it('rejects mismatched actual cash without debiting or fulfilling', async () => {
    const f = fixture(); f.intent.amount_received = 1999;
    await expect(processBalanceIntent(f.intent, f.deps)).rejects.toThrow('mismatch');
    expect(f.rpc).not.toHaveBeenCalled(); expect(completePaidOrder).not.toHaveBeenCalled();
  });
  it('keeps holds after a declined or processing attempt', async () => {
    const f = fixture();
    for (const status of ['requires_payment_method', 'processing'] as const) {
      f.intent.status = status;
      expect(await processBalanceIntent(f.intent, f.deps)).toBe(true);
    }
    expect(f.rpc).not.toHaveBeenCalled(); expect(completePaidOrder).not.toHaveBeenCalled();
  });
  it('releases only after observing a terminal cancellation', async () => {
    const f = fixture(); f.intent.status = 'canceled';
    await processBalanceIntent(f.intent, f.deps);
    expect(f.rpc).toHaveBeenCalledWith('abort_balance_order', { p_order_id: 'o1', p_intent_id: 'pi1' });
  });
  it('compensates lost ceramic reservations before releasing the card hold', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: 0, error: { message: 'ceramic_reservation_lost' } });
    await processBalanceIntent(f.intent, f.deps);
    expect(f.stripe.refunds.create).toHaveBeenCalledOnce();
    expect(f.rpc.mock.calls.at(-1)?.[0]).toBe('abort_balance_order');
    expect(completePaidOrder).not.toHaveBeenCalled();
  });
  it('does not release funds while a compensation is pending', async () => {
    const f = fixture(); f.order.refund_pending_at = new Date().toISOString();
    f.stripe.refunds.create.mockResolvedValueOnce({ status: 'pending' });
    await expect(processBalanceIntent(f.intent, f.deps)).rejects.toThrow('pending');
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('a late success on a refunded order cannot fulfil it again', async () => {
    const f = fixture(); f.order.status = 'refunded';
    await processBalanceIntent(f.intent, f.deps);
    expect(finishBalanceRefund).toHaveBeenCalledWith('o1', f.deps);
    expect(completePaidOrder).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('intercepts partial cash refunds so legacy full-order relisting cannot run', async () => {
    const f = fixture();
    expect(await handleBalancePaymentEvent({ type: 'charge.refunded', data: { object: { payment_intent: 'pi1', amount: 2000, amount_refunded: 500 } } } as never, f.deps)).toBe(true);
    expect(reconcileBalanceRefunds).toHaveBeenCalled();
  });
});
