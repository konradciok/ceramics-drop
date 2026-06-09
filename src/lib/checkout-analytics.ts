import {
  buildBeginCheckoutEvent,
  buildEngagementEvent,
  buildPurchaseEvent,
  pushDataLayer,
  type DataLayerEvent,
} from './analytics';
import { resolveKnownProducts } from './products';
import type { Product } from './types';

type CheckoutStartOptions = {
  shippingCost: number;
  shippingMethod: string;
  userData?: { em?: string };
  push?: (event: DataLayerEvent) => void;
};

type ConfirmedPurchaseOptions = CheckoutStartOptions & {
  orderNo: string;
};

type SimpleStorage = Pick<Storage, 'getItem' | 'setItem'> & {
  removeItem?: (key: string) => void;
};

const PURCHASE_DEDUPE_PREFIX = 'acc_purchase_pi:';
const PAYMENT_FAILED_DEDUPE_PREFIX = 'acc_payment_failed_pi:';
const CHECKOUT_SNAPSHOT_KEY = 'acc_checkout_snapshot';

type CheckoutSnapshot = {
  ids: string[];
  shippingCost: number;
  shippingMethod: string;
};

export function pushCheckoutStarted(
  products: Product[],
  { shippingCost, shippingMethod, userData, push = pushDataLayer }: CheckoutStartOptions,
): void {
  push(
    buildBeginCheckoutEvent(products, {
      shippingCost,
      shippingMethod,
      userData,
    }),
  );
}

export function pushConfirmedPurchase(
  products: Product[],
  { orderNo, shippingCost, shippingMethod, push = pushDataLayer }: ConfirmedPurchaseOptions,
): void {
  push(
    buildPurchaseEvent(products, {
      orderNo,
      shippingCost,
      shippingMethod,
    }),
  );
}

export function pushConfirmedPurchaseByIdsOnce(
  paymentIntentId: string,
  ids: string[],
  options: ConfirmedPurchaseOptions & { storage?: SimpleStorage },
): boolean {
  const storage = options.storage ?? getDefaultStorage();
  const key = `${PURCHASE_DEDUPE_PREFIX}${paymentIntentId}`;
  if (safeGetItem(storage, key) === '1') return false;

  const products = resolveKnownProducts(ids);
  if (products.length === 0) return false;

  pushConfirmedPurchase(products, options);
  safeSetItem(storage, key, '1');
  return true;
}

/**
 * Fire `payment_failed` at most once per PaymentIntent. The return page mounts on
 * every visit/refresh (and twice under React Strict Mode in dev), so without this
 * guard a buyer reloading the failure screen would inflate the count — mirrors the
 * purchase dedupe above. `status` is the PaymentIntent status (the PI id is never sent).
 */
export function pushPaymentFailedOnce(
  paymentIntentId: string,
  status: string,
  options: { push?: (event: DataLayerEvent) => void; storage?: SimpleStorage } = {},
): boolean {
  const storage = options.storage ?? getDefaultStorage();
  const key = `${PAYMENT_FAILED_DEDUPE_PREFIX}${paymentIntentId}`;
  if (safeGetItem(storage, key) === '1') return false;

  (options.push ?? pushDataLayer)(buildEngagementEvent('payment_failed', { status }));
  safeSetItem(storage, key, '1');
  return true;
}

export function rememberCheckoutForReturn(
  ids: string[],
  options: CheckoutStartOptions & { storage?: SimpleStorage },
): void {
  const storage = options.storage ?? getDefaultStorage();
  if (!storage) return;

  const snapshot: CheckoutSnapshot = {
    ids,
    shippingCost: options.shippingCost,
    shippingMethod: options.shippingMethod,
  };
  safeSetItem(storage, CHECKOUT_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function forgetRememberedCheckout(storage = getDefaultStorage()): void {
  safeRemoveItem(storage, CHECKOUT_SNAPSHOT_KEY);
}

export function pushConfirmedPurchaseFromRememberedCheckout(
  paymentIntentId: string,
  orderNoOrOptions:
    | string
    | { orderNo?: string; push?: (event: DataLayerEvent) => void; storage?: SimpleStorage },
  maybeOptions?: { push?: (event: DataLayerEvent) => void; storage?: SimpleStorage },
): boolean {
  const options =
    typeof orderNoOrOptions === 'string'
      ? maybeOptions ?? {}
      : orderNoOrOptions;
  const orderNo =
    typeof orderNoOrOptions === 'string'
      ? orderNoOrOptions
      : orderNoOrOptions.orderNo ?? paymentIntentId;
  const storage = options.storage ?? getDefaultStorage();
  const snapshot = readCheckoutSnapshot(storage);
  if (!snapshot) return false;

  const fired = pushConfirmedPurchaseByIdsOnce(paymentIntentId, snapshot.ids, {
    orderNo,
    shippingCost: snapshot.shippingCost,
    shippingMethod: snapshot.shippingMethod,
    push: options.push,
    storage,
  });

  if (fired) forgetRememberedCheckout(storage);

  return fired;
}

function readCheckoutSnapshot(storage?: SimpleStorage): CheckoutSnapshot | null {
  const raw = safeGetItem(storage, CHECKOUT_SNAPSHOT_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'ids' in parsed &&
      Array.isArray(parsed.ids) &&
      'shippingCost' in parsed &&
      typeof parsed.shippingCost === 'number' &&
      'shippingMethod' in parsed &&
      typeof parsed.shippingMethod === 'string'
    ) {
      return {
        ids: parsed.ids.filter((id): id is string => typeof id === 'string'),
        shippingCost: parsed.shippingCost,
        shippingMethod: parsed.shippingMethod,
      };
    }
  } catch {
    // Ignore malformed snapshot data; analytics must not break the app.
  }

  return null;
}

function getDefaultStorage(): SimpleStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    // Accessing Web Storage can throw (blocked storage, some private modes);
    // analytics must never break the storefront.
    return undefined;
  }
}

function safeGetItem(storage: SimpleStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSetItem(storage: SimpleStorage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Best-effort: ignore storage write failures (quota, blocked storage).
  }
}

function safeRemoveItem(storage: SimpleStorage | undefined, key: string): void {
  try {
    storage?.removeItem?.(key);
  } catch {
    // Best-effort: ignore storage removal failures.
  }
}
