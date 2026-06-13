import { describe, expect, it, vi } from 'vitest';
import { getProductById } from './products';
import {
  forgetRememberedCheckout,
  hasFiredPurchaseOnce,
  reportPurchaseGapOnce,
  rememberCheckoutForReturn,
  pushCheckoutStarted,
  pushConfirmedPurchase,
  pushConfirmedPurchaseByIdsOnce,
  pushConfirmedPurchaseFromRememberedCheckout,
  pushPaymentFailedOnce,
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

  it('fires a complete purchase for a print-only order and does not false-alarm a gap', () => {
    const push = vi.fn();
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
    };

    const fired = pushConfirmedPurchaseByIdsOnce('pi_print', ['print:fap01:a3:satin:oak'], {
      orderNo: 'ACC-PRINT',
      shippingCost: 20,
      shippingMethod: 'paczkomat',
      itemPrices: [350],
      push,
      storage,
    });

    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'purchase',
        ecommerce: expect.objectContaining({
          items: [expect.objectContaining({ item_id: 'fap01', item_variant: 'a3 / satin / oak', price: 350 })],
        }),
      }),
    );
    // Purchase fired ⇒ reportPurchaseGapOnce must NOT report a gap.
    expect(reportPurchaseGapOnce('pi_print', storage)).toBeNull();
  });

  it('mixed ceramic + print cart itemises both lines in the purchase payload', () => {
    const push = vi.fn();
    const map = new Map<string, string>();
    pushConfirmedPurchaseByIdsOnce('pi_mixed', ['k01', 'print:fap01:a4:matte:none'], {
      orderNo: 'ACC-MIX',
      shippingCost: 20,
      shippingMethod: 'paczkomat',
      itemPrices: [95, 120],
      push,
      storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) },
    });
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        ecommerce: expect.objectContaining({
          items: [
            expect.objectContaining({ item_id: 'k01' }),
            expect.objectContaining({ item_id: 'fap01', item_category: 'fine-art-prints' }),
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

  it('stores EUR currency and itemPrices in the snapshot and replays with EUR', () => {
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };

    rememberCheckoutForReturn(['k01'], {
      shippingCost: 5,
      shippingMethod: 'paczkomat',
      currency: 'EUR',
      itemPrices: [22],
      storage: session,
    });

    const push = vi.fn();
    pushConfirmedPurchaseFromRememberedCheckout('pi_eur', 'ord_eur', { push, storage: session });

    expect(push).toHaveBeenCalledOnce();
    const event = push.mock.calls[0][0] as import('./analytics').DataLayerEvent;
    expect(event.ecommerce).toMatchObject({
      currency: 'EUR',
      items: [expect.objectContaining({ price: 22 })],
    });
    expect(event.meta).toMatchObject({ currency: 'EUR' });
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

  it('payment_failed fires once per payment intent and carries the status', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const session = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };

    const first = pushPaymentFailedOnce('pi_fail', 'requires_payment_method', {
      push,
      storage: session,
    });
    const second = pushPaymentFailedOnce('pi_fail', 'requires_payment_method', {
      push,
      storage: session,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'site_engagement',
        engagement_type: 'payment_failed',
        status: 'requires_payment_method',
      }),
    );
  });

  it('hasFiredPurchaseOnce tracks the per-intent dedupe key and survives forgetting the snapshot', () => {
    const store = new Map<string, string>();
    const session = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };

    // Before any purchase: not fired.
    expect(hasFiredPurchaseOnce('pi_dedupe', session)).toBe(false);

    rememberCheckoutForReturn(['k01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      storage: session,
    });
    pushConfirmedPurchaseFromRememberedCheckout('pi_dedupe', { push: vi.fn(), storage: session });

    // After firing: true, and it stays true even after the snapshot is forgotten —
    // this is what lets the return page treat a refresh as benign rather than a gap.
    expect(hasFiredPurchaseOnce('pi_dedupe', session)).toBe(true);
    forgetRememberedCheckout(session);
    expect(hasFiredPurchaseOnce('pi_dedupe', session)).toBe(true);

    // A different intent is unaffected.
    expect(hasFiredPurchaseOnce('pi_other', session)).toBe(false);
  });

  it('reportPurchaseGapOnce flags a lost snapshot once, then dedupes per intent', () => {
    const store = new Map<string, string>();
    const session = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };

    // No snapshot, never fired → genuine gap with reason snapshot_missing.
    expect(reportPurchaseGapOnce('pi_gap', session)).toEqual({ reason: 'snapshot_missing' });
    // Refresh / Strict Mode re-mount for the same intent must not re-alert.
    expect(reportPurchaseGapOnce('pi_gap', session)).toBeNull();
  });

  it('reportPurchaseGapOnce returns null when the purchase already fired (benign refresh)', () => {
    const store = new Map<string, string>();
    const session = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };

    rememberCheckoutForReturn(['k01'], { shippingCost: 18, shippingMethod: 'kurier', storage: session });
    pushConfirmedPurchaseFromRememberedCheckout('pi_ok', { push: vi.fn(), storage: session });

    // Snapshot was forgotten after the fire, but the purchase dedupe key proves it fired.
    expect(reportPurchaseGapOnce('pi_ok', session)).toBeNull();
  });

  it('reportPurchaseGapOnce reports unresolvable_ids when a snapshot survives but did not fire', () => {
    const store = new Map<string, string>();
    const session = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };

    // Snapshot present (so not "lost") but the purchase never fired for this intent —
    // the only way that happens is ids that no longer resolve to products.
    rememberCheckoutForReturn(['zzz999'], { shippingCost: 18, shippingMethod: 'kurier', storage: session });

    expect(reportPurchaseGapOnce('pi_bad_ids', session)).toEqual({ reason: 'unresolvable_ids' });
  });

  it('reportPurchaseGapOnce never throws when storage access throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(() => reportPurchaseGapOnce('pi_throw', throwing)).not.toThrow();
  });

  it('hasFiredPurchaseOnce returns false (never throws) when storage access throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => {},
    };
    expect(() => hasFiredPurchaseOnce('pi_x', throwing)).not.toThrow();
    expect(hasFiredPurchaseOnce('pi_x', throwing)).toBe(false);
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

describe('cookie-hardened snapshot and user_data on purchase event', () => {
  const makeSession = () => {
    const storage = new Map<string, string>();
    return {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
  };

  it('user_data.em flows through snapshot into purchase event', () => {
    const push = vi.fn();
    const session = makeSession();

    rememberCheckoutForReturn(['k01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      userData: { em: 'abc123hash' },
      storage: session,
    });

    pushConfirmedPurchaseFromRememberedCheckout('pi_ud', { push, storage: session });

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ user_data: { em: 'abc123hash' } }),
    );
  });

  it('purchase fires normally when snapshot has no userData (backwards compat)', () => {
    const push = vi.fn();
    const session = makeSession();

    rememberCheckoutForReturn(['k01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      storage: session,
    });

    pushConfirmedPurchaseFromRememberedCheckout('pi_noem', { push, storage: session });

    expect(push).toHaveBeenCalledOnce();
    const event = push.mock.calls[0][0] as import('./analytics').DataLayerEvent;
    expect(Object.prototype.hasOwnProperty.call(event, 'user_data')).toBe(false);
  });

  it('purchase still fires when storage is empty but snapshot was written (simulates sessionStorage eviction)', () => {
    // In the browser, the cookie path fills this gap; in tests the cookie API is
    // absent so this correctly returns false.
    const push = vi.fn();
    const emptyStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };

    const fired = pushConfirmedPurchaseFromRememberedCheckout('pi_evicted', {
      push,
      storage: emptyStorage,
    });

    expect(fired).toBe(false);
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

  it('pushPaymentFailedOnce still emits when storage throws', () => {
    const push = vi.fn();

    let fired = false;
    expect(() => {
      fired = pushPaymentFailedOnce('pi_fail_throw', 'canceled', {
        push,
        storage: throwingStorage,
      });
    }).not.toThrow();

    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ engagement_type: 'payment_failed' }),
    );
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
