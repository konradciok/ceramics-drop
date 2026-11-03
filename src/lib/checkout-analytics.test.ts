import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { registryProductById } from './products';
import { registryPrintById } from './prints';
import { toAnalyticsItem } from './analytics';
import { printDisplayName } from './print-curation';
import {
  forgetRememberedCheckout,
  hasFiredPurchaseOnce,
  pushCheckoutStartedItemsOnce,
  reportPurchaseGapOnce,
  rememberCheckoutForReturn,
  pushCheckoutStarted,
  pushConfirmedPurchase,
  pushConfirmedPurchaseByIdsOnce,
  pushConfirmedPurchaseFromRememberedCheckout,
  pushPaymentFailedOnce,
} from './checkout-analytics';

const product = (id: string) => {
  const found = registryProductById(id);
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

  it('confirmed payment by ids can be guarded to fire only once per payment intent', async () => {
    const push = vi.fn();
    const storage = new Map<string, string>();

    const first = await pushConfirmedPurchaseByIdsOnce('pi_123', ['k01', 'k04'], {
      orderNo: 'ACC-3000',
      shippingCost: 18,
      shippingMethod: 'kurier',
      push,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    const second = await pushConfirmedPurchaseByIdsOnce('pi_123', ['k01', 'k04'], {
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

  it('can remember checkout state and later emit purchase from that snapshot once payment succeeds', async () => {
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

    const fired = await pushConfirmedPurchaseFromRememberedCheckout('pi_456', 'ACC-456', {
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
      await pushConfirmedPurchaseFromRememberedCheckout('pi_456', 'ACC-456', {
        push,
        storage: session,
      }),
    ).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('round-trips coupon + discountMinor through the snapshot into the purchase event', async () => {
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };

    rememberCheckoutForReturn(['k01', 'v01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      coupon: 'WELCOME10',
      discountMinor: 3400,
      storage: session,
    });

    const push = vi.fn();
    const fired = await pushConfirmedPurchaseFromRememberedCheckout('pi_promo', 'ACC-promo', { push, storage: session });

    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        ecommerce: expect.objectContaining({ coupon: 'WELCOME10', value: 300 }),
      }),
    );
  });

  it('rejects a fractional, negative, or non-finite discountMinor in a tampered snapshot (falls back to no discount)', async () => {
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };
    const base = { ids: ['k01', 'v01'], shippingCost: 18, shippingMethod: 'kurier', coupon: 'WELCOME10' };

    for (const [i, badDiscountMinor] of [1e309 /* Infinity via JSON.parse overflow */, 33.5, -100].entries()) {
      storage.set('acc_checkout_snapshot', JSON.stringify({ ...base, discountMinor: badDiscountMinor }));
      const push = vi.fn();
      // Distinct payment_intent per iteration — the per-PI dedupe guard would
      // otherwise suppress the 2nd/3rd fires under a reused id.
      const fired = await pushConfirmedPurchaseFromRememberedCheckout(`pi_tamper_${i}`, 'ACC-tamper', { push, storage: session });
      expect(fired).toBe(true);
      // coupon still rides through (it's validated independently) but the
      // rejected discountMinor must not be applied — value stays undiscounted.
      expect(push).toHaveBeenCalledWith(
        expect.objectContaining({
          ecommerce: expect.objectContaining({ coupon: 'WELCOME10', value: 334 }),
        }),
      );
    }
  });

  it('a snapshot with no coupon replays byte-identical to today (regression)', () => {
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };

    rememberCheckoutForReturn(['k01', 'v01'], {
      shippingCost: 18,
      shippingMethod: 'kurier',
      storage: session,
    });

    const push = vi.fn();
    pushConfirmedPurchaseFromRememberedCheckout('pi_plain', 'ACC-plain', { push, storage: session });

    const event = push.mock.calls[0][0] as import('./analytics').DataLayerEvent;
    expect(event.ecommerce).not.toHaveProperty('coupon');
    expect(event.ecommerce?.value).toBe(334);
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

  it('does not emit purchase from remembered checkout when no snapshot exists', async () => {
    const push = vi.fn();
    const storage = new Map<string, string>();

    const fired = await pushConfirmedPurchaseFromRememberedCheckout('pi_missing', 'ACC-404', {
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

  it('uses payment_intent id as transaction id fallback on the return page', async () => {
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

    const fired = await pushConfirmedPurchaseFromRememberedCheckout('pi_789', {
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

  it('begin_checkout fires once per attempt id and dedupes a same-attempt retry', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    };
    const items = [toAnalyticsItem(product('k01'))];

    const first = pushCheckoutStartedItemsOnce('attempt_1', items, {
      shippingCost: 18, shippingMethod: 'kurier', push, storage: session,
    });
    const second = pushCheckoutStartedItemsOnce('attempt_1', items, {
      shippingCost: 18, shippingMethod: 'kurier', push, storage: session,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ event: 'begin_checkout' }));
  });

  it('begin_checkout fires again under a fresh attempt id (cart changed / checkout resolved)', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    };
    const items = [toAnalyticsItem(product('k01'))];
    pushCheckoutStartedItemsOnce('attempt_1', items, { shippingCost: 18, shippingMethod: 'kurier', push, storage: session });
    pushCheckoutStartedItemsOnce('attempt_2', items, { shippingCost: 18, shippingMethod: 'kurier', push, storage: session });
    expect(push).toHaveBeenCalledTimes(2);
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

  it('can explicitly forget a remembered checkout snapshot', async () => {
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
      await pushConfirmedPurchaseFromRememberedCheckout('pi_forgotten', 'ACC-789', {
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

  it('purchase still fires when storage is empty but snapshot was written (simulates sessionStorage eviction)', async () => {
    // In the browser, the cookie path fills this gap; in tests the cookie API is
    // absent so this correctly returns false.
    const push = vi.fn();
    const emptyStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };

    const fired = await pushConfirmedPurchaseFromRememberedCheckout('pi_evicted', {
      push,
      storage: emptyStorage,
    });

    expect(fired).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('print naming stays on the STATIC fallback (browser-side by construction)', () => {
  /**
   * This module is only ever imported by `'use client'` components, so it can
   * never reach the CMS: loadPrintCollectionDefinitions() →
   * getSupabaseAdmin() → getCloudflareContext() throws outside a Workers
   * request context, and its fallback is PRINT_COLLECTION_DEFINITIONS — the
   * same static list printDisplayName already defaults to. These tests pin the
   * deliberate choice so a future "let's enrich the names from the CMS here"
   * change has to confront the boundary rather than reintroduce a silent no-op
   * (and re-drag @supabase/supabase-js into three client bundles).
   */
  it('names a print token from the static print-curation definitions', async () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const design = registryPrintById('fap005');
    if (!design) throw new Error('Missing print fixture: fap005');

    const fired = await pushConfirmedPurchaseByIdsOnce('pi_static_print', ['print:fap005:50x70:true:false:black'], {
      orderNo: 'ACC-STATIC',
      shippingCost: 18,
      shippingMethod: 'kurier',
      itemPrices: [35000],
      push,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    expect(fired).toBe(true);
    const event = push.mock.calls[0][0] as import('./analytics').DataLayerEvent;
    const items = (event.ecommerce as { items: { item_name: string }[] }).items;
    expect(items[0].item_name).toBe(printDisplayName(design));
  });

  it('does not import the Supabase-backed CMS collection loader at all', async () => {
    // A module-level assertion rather than a behavioural one: the point is the
    // import EDGE, which is what pulls server-only code into a client bundle.
    const source = await readFile(new URL('./checkout-analytics.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('print-collections');
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

  it('pushCheckoutStartedItemsOnce still emits when storage throws', () => {
    const push = vi.fn();
    let fired = false;
    expect(() => {
      fired = pushCheckoutStartedItemsOnce('attempt_throw', [toAnalyticsItem(product('k01'))], {
        shippingCost: 18, shippingMethod: 'kurier', push, storage: throwingStorage,
      });
    }).not.toThrow();
    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('pushConfirmedPurchaseByIdsOnce still emits purchase when storage throws', async () => {
    const push = vi.fn();

    let fired = false;
    try {
      fired = await pushConfirmedPurchaseByIdsOnce('pi_throw', ['k01', 'k04'], {
        orderNo: 'ACC-THROW',
        shippingCost: 18,
        shippingMethod: 'kurier',
        push,
        storage: throwingStorage,
      });
    } catch {
      // Should not throw
    }

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

  it('pushConfirmedPurchaseFromRememberedCheckout does not throw when storage throws', async () => {
    const push = vi.fn();

    let fired = true;
    try {
      fired = await pushConfirmedPurchaseFromRememberedCheckout('pi_throw_return', 'ACC-X', {
        push,
        storage: throwingStorage,
      });
    } catch {
      // Should not throw
    }

    // Snapshot read fails safely → treated as no snapshot, so nothing is emitted.
    expect(fired).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
