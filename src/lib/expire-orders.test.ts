import { describe, it, expect, vi } from 'vitest';
import {
  expireAbandonedOrders,
  type AbandonedOrder,
  type CancelOutcome,
  type ExpireOrdersDeps,
} from './expire-orders';

function order(id: string): AbandonedOrder {
  return { id, payment_intent_id: `pi_${id}` };
}

function deps(overrides: Partial<ExpireOrdersDeps> = {}): ExpireOrdersDeps {
  return {
    loadAbandoned: vi.fn().mockResolvedValue([]),
    cancelIntent: vi.fn().mockResolvedValue('canceled' as CancelOutcome),
    expireOrder: vi.fn().mockResolvedValue(true),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('expireAbandonedOrders', () => {
  it("'canceled' outcome → expireOrder called and counted in expired", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('canceled' as CancelOutcome),
      expireOrder: vi.fn().mockResolvedValue(true),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).toHaveBeenCalledWith('a');
    expect(result).toEqual({ scanned: 1, expired: 1, stillActive: 0, errors: 0 });
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("'canceled' but expireOrder returns false → NOT counted in expired", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('canceled' as CancelOutcome),
      expireOrder: vi.fn().mockResolvedValue(false),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).toHaveBeenCalledWith('a');
    expect(result).toEqual({ scanned: 1, expired: 0, stillActive: 0, errors: 0 });
  });

  it("'paid' outcome → expireOrder NOT called, counted in stillActive, warn called", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('paid' as CancelOutcome),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn).toHaveBeenCalledWith(expect.any(String), { orderId: 'a', paymentIntentId: 'pi_a' });
    expect(result).toEqual({ scanned: 1, expired: 0, stillActive: 1, errors: 0 });
  });

  it("'error' outcome → expireOrder NOT called, counted in errors", async () => {
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue([order('a')]),
      cancelIntent: vi.fn().mockResolvedValue('error' as CancelOutcome),
    });
    const result = await expireAbandonedOrders(d);
    expect(d.expireOrder).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, expired: 0, stillActive: 0, errors: 1 });
  });

  it('mixed batch → correct aggregate counts and scanned === input length', async () => {
    const batch = [order('a'), order('b'), order('c'), order('d'), order('e')];
    const outcomes: Record<string, CancelOutcome> = {
      pi_a: 'canceled',
      pi_b: 'canceled',
      pi_c: 'paid',
      pi_d: 'error',
      pi_e: 'canceled',
    };
    const d = deps({
      loadAbandoned: vi.fn().mockResolvedValue(batch),
      cancelIntent: vi.fn().mockImplementation((pi: string) => Promise.resolve(outcomes[pi])),
      // 'a' and 'e' actually expire; 'b' was already gone (false).
      expireOrder: vi.fn().mockImplementation((id: string) => Promise.resolve(id !== 'b')),
    });
    const result = await expireAbandonedOrders(d);
    expect(result).toEqual({ scanned: 5, expired: 2, stillActive: 1, errors: 1 });
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it('propagates a loadAbandoned failure (caller must handle it)', async () => {
    const d = deps({ loadAbandoned: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(expireAbandonedOrders(d)).rejects.toThrow('db down');
    expect(d.cancelIntent).not.toHaveBeenCalled();
  });

  it('empty batch → all zeros', async () => {
    const d = deps({ loadAbandoned: vi.fn().mockResolvedValue([]) });
    const result = await expireAbandonedOrders(d);
    expect(result).toEqual({ scanned: 0, expired: 0, stillActive: 0, errors: 0 });
    expect(d.cancelIntent).not.toHaveBeenCalled();
    expect(d.expireOrder).not.toHaveBeenCalled();
  });
});
