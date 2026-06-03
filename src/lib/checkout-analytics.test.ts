import { describe, expect, it, vi } from 'vitest';
import { getProductById } from './products';
import {
  forgetRememberedCheckout,
  rememberCheckoutForReturn,
  pushCheckoutStarted,
  pushConfirmedPurchase,
  pushConfirmedPurchaseByIdsOnce,
  pushConfirmedPurchaseFromRememberedCheckout,
} from './checkout-analytics';

const product = (id: string) => {
  const found = getProductById(id);
  if (!found) throw new Error(`Missing product fixture: ${id}`);
  return found;
};

describe('checkout analytics semantics', () => {
  it('checkout start pushes only begin_checkout until payment is actually confirmed', () => {
    const push = vi.fn();

    pushCheckoutStarted([product('k01'), product('v01')], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      push,
    });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'begin_checkout',
      }),
    );
    expect(push).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'purchase',
      }),
    );
  });

  it('confirmed payment pushes purchase separately from checkout start', () => {
    const push = vi.fn();

    pushConfirmedPurchase([product('k01'), product('v01')], {
      orderNo: 'ACC-1234',
      shippingCost: 18,
      shippingMethod: 'kurier',
      push,
    });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'purchase',
      }),
    );
  });

  it('confirmed payment by product ids keeps sold pieces in the purchase payload', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();

    pushConfirmedPurchaseByIdsOnce('pi_sold', ['k01', 'k04'], {
      orderNo: 'ACC-2000',
      shippingCost: 18,
      shippingMethod: 'kurier',
      push,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'purchase',
        ecommerce: expect.objectContaining({
          items: [
            expect.objectContaining({ item_id: 'k01' }),
            expect.objectContaining({ item_id: 'k04' }),
          ],
        }),
      }),
    );
  });

  it('confirmed payment by ids can be guarded to fire only once per payment intent', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();

    const first = pushConfirmedPurchaseByIdsOnce('pi_123', ['k01', 'k04'], {
      orderNo: 'ACC-3000',
      shippingCost: 18,
      shippingMethod: 'kurier',
      push,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    const second = pushConfirmedPurchaseByIdsOnce('pi_123', ['k01', 'k04'], {
      orderNo: 'ACC-3000',
      shippingCost: 18,
      shippingMethod: 'kurier',
      push,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'purchase',
      }),
    );
  });

  it('can remember checkout state and later emit purchase from that snapshot once payment succeeds', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const session = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    rememberCheckoutForReturn(['k01', 'v01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      storage: session,
    });

    const fired = pushConfirmedPurchaseFromRememberedCheckout('pi_456', 'ACC-456', {
      push,
      storage: session,
    });

    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'purchase',
        ecommerce: expect.objectContaining({
          transaction_id: 'ACC-456',
          items: [
            expect.objectContaining({ item_id: 'k01' }),
            expect.objectContaining({ item_id: 'v01' }),
          ],
        }),
      }),
    );
    // Per-payment-intent dedupe: re-store a snapshot and replay with the SAME
    // intent id. It must not fire again, because the dedupe key is already set
    // (not merely because the snapshot was consumed by the first fire).
    rememberCheckoutForReturn(['k01', 'v01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      storage: session,
    });
    expect(
      pushConfirmedPurchaseFromRememberedCheckout('pi_456', 'ACC-456', {
        push,
        storage: session,
      }),
    ).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('does not emit purchase from remembered checkout when no snapshot exists', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();

    const fired = pushConfirmedPurchaseFromRememberedCheckout('pi_missing', 'ACC-404', {
      push,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });

    expect(fired).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('uses payment_intent id as transaction id fallback on the return page', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const session = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    rememberCheckoutForReturn(['k01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      storage: session,
    });

    const fired = pushConfirmedPurchaseFromRememberedCheckout('pi_789', {
      push,
      storage: session,
    });

    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'purchase',
        ecommerce: expect.objectContaining({
          transaction_id: 'pi_789',
        }),
        meta: expect.objectContaining({
          order_id: 'pi_789',
        }),
      }),
    );
  });

  it('can explicitly forget a remembered checkout snapshot', () => {
    const storage = new Map<string, string>();
    const session = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    rememberCheckoutForReturn(['k01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      storage: session,
    });
    forgetRememberedCheckout(session);

    const push = vi.fn();
    expect(
      pushConfirmedPurchaseFromRememberedCheckout('pi_forgotten', 'ACC-789', {
        push,
        storage: session,
      }),
    ).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('checkout analytics never breaks the storefront when storage throws', () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error('storage blocked');
    },
    setItem: () => {
      throw new Error('storage blocked');
    },
    removeItem: () => {
      throw new Error('storage blocked');
    },
  };

  it('rememberCheckoutForReturn swallows storage write failures', () => {
    expect(() =>
      rememberCheckoutForReturn(['k01'], {
        shippingCost: 18,
        shippingMethod: 'kurier',
        storage: throwingStorage,
      }),
    ).not.toThrow();
  });

  it('pushConfirmedPurchaseByIdsOnce still emits purchase when storage throws', () => {
    const push = vi.fn();

    let fired = false;
    expect(() => {
      fired = pushConfirmedPurchaseByIdsOnce('pi_throw', ['k01', 'k04'], {
        orderNo: 'ACC-THROW',
        shippingCost: 18,
        shippingMethod: 'kurier',
        push,
        storage: throwingStorage,
      });
    }).not.toThrow();

    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'purchase' }),
    );
  });

  it('forgetRememberedCheckout swallows storage removal failures', () => {
    expect(() => forgetRememberedCheckout(throwingStorage)).not.toThrow();
  });

  it('pushConfirmedPurchaseFromRememberedCheckout does not throw when storage throws', () => {
    const push = vi.fn();

    let fired = true;
    expect(() => {
      fired = pushConfirmedPurchaseFromRememberedCheckout('pi_throw_return', 'ACC-X', {
        push,
        storage: throwingStorage,
      });
    }).not.toThrow();

    // Snapshot read fails safely → treated as no snapshot, so nothing is emitted.
    expect(fired).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
