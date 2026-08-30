import {
  analyticsItemsForIds,
  buildBeginCheckoutEvent,
  buildBeginCheckoutEventFromItems,
  buildEngagementEvent,
  buildPurchaseEvent,
  buildPurchaseEventFromItems,
  pushDataLayer,
  type AnalyticsItem,
  type DataLayerEvent,
} from './analytics';
import type { Product } from './types';
import type { CurrencyCode } from './format';

type CheckoutStartOptions = {
  shippingCost: number;
  shippingMethod: string;
  userData?: { em?: string };
  push?: (event: DataLayerEvent) => void;
  currency?: CurrencyCode;
  itemPrices?: number[];
  /** Applied promo code — forwarded to the GA4-standard ecommerce.coupon param. */
  coupon?: string;
  /** Discount in MINOR units — the builder converts to major units. */
  discountMinor?: number;
};

type ConfirmedPurchaseOptions = CheckoutStartOptions & {
  orderNo: string;
};

type SimpleStorage = Pick<Storage, 'getItem' | 'setItem'> & {
  removeItem?: (key: string) => void;
};

const PURCHASE_DEDUPE_PREFIX = 'acc_purchase_pi:';
const PURCHASE_GAP_DEDUPE_PREFIX = 'acc_purchase_gap_pi:';
const PAYMENT_FAILED_DEDUPE_PREFIX = 'acc_payment_failed_pi:';
const BEGIN_CHECKOUT_DEDUPE_PREFIX = 'acc_begin_checkout_attempt:';
const CHECKOUT_SNAPSHOT_KEY = 'acc_checkout_snapshot';

type CheckoutSnapshot = {
  ids: string[];
  shippingCost: number;
  shippingMethod: string;
  currency?: CurrencyCode;
  itemPrices?: number[];
  userData?: { em?: string };
  coupon?: string;
  discountMinor?: number;
};

export function pushCheckoutStarted(
  products: Product[],
  { shippingCost, shippingMethod, userData, currency, itemPrices, push = pushDataLayer }: CheckoutStartOptions,
): void {
  push(
    buildBeginCheckoutEvent(products, {
      shippingCost,
      shippingMethod,
      userData,
      currency,
      itemPrices,
    }),
  );
}

/** begin_checkout from pre-resolved AnalyticsItems (mixed ceramic + print carts). */
export function pushCheckoutStartedItems(
  items: AnalyticsItem[],
  { shippingCost, shippingMethod, userData, currency, coupon, discountMinor, push = pushDataLayer }: CheckoutStartOptions,
): void {
  push(buildBeginCheckoutEventFromItems(items, { shippingCost, shippingMethod, userData, currency, coupon, discountMinor }));
}

/**
 * begin_checkout fired at most once per checkout attempt. CartView regenerates
 * `attemptId` whenever the cart changes or a checkout resolves (success, order_conflict,
 * hard failure), so a retry after a *recoverable* error (network drop, checkout_in_progress)
 * reuses the same attemptId and must not emit a second begin_checkout. Mirrors
 * pushPaymentFailedOnce. Returns true if it fired, false if already fired for this attempt.
 */
export function pushCheckoutStartedItemsOnce(
  attemptId: string,
  items: AnalyticsItem[],
  options: CheckoutStartOptions & { storage?: SimpleStorage },
): boolean {
  const storage = options.storage ?? getDefaultStorage();
  const key = `${BEGIN_CHECKOUT_DEDUPE_PREFIX}${attemptId}`;
  if (safeGetItem(storage, key) === '1') return false;

  pushCheckoutStartedItems(items, options);
  safeSetItem(storage, key, '1');
  return true;
}

export function pushConfirmedPurchase(
  products: Product[],
  { orderNo, shippingCost, shippingMethod, userData, currency, itemPrices, push = pushDataLayer }: ConfirmedPurchaseOptions,
): void {
  push(
    buildPurchaseEvent(products, {
      orderNo,
      shippingCost,
      shippingMethod,
      userData,
      currency,
      itemPrices,
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

  // Resolve both ceramic ids and print tokens; a print-only order would otherwise
  // produce zero items here, skipping the browser purchase event (and tripping a
  // false reportPurchaseGapOnce 'unresolvable_ids' alert).
  const items = analyticsItemsForIds(ids, options.itemPrices);
  if (items.length === 0) return false;

  (options.push ?? pushDataLayer)(buildPurchaseEventFromItems(items, options));
  safeSetItem(storage, key, '1');
  return true;
}

/**
 * Whether the purchase event has already been fired for this PaymentIntent.
 * Reads the same per-intent dedupe key set by {@link pushConfirmedPurchaseByIdsOnce};
 * the key survives `forgetRememberedCheckout` (which only clears the snapshot), so
 * this stays `true` across return-page refreshes. The return page uses it to tell a
 * benign refresh (snapshot already consumed, purchase already fired) apart from a
 * genuine "succeeded PI, but the purchase event never fired" gap worth alerting on.
 */
export function hasFiredPurchaseOnce(
  paymentIntentId: string,
  storage: SimpleStorage | undefined = getDefaultStorage(),
): boolean {
  return safeGetItem(storage, `${PURCHASE_DEDUPE_PREFIX}${paymentIntentId}`) === '1';
}

export type PurchaseGapReason = 'snapshot_missing' | 'unresolvable_ids';

/**
 * Decide whether a succeeded PaymentIntent whose browser purchase event never fired
 * is a genuine, not-yet-reported attribution gap — and if so, mark it reported so the
 * alert fires at most once per intent (mirrors the dedupe in `pushPaymentFailedOnce` /
 * `pushConfirmedPurchaseByIdsOnce`; survives return-page refreshes and React Strict Mode
 * double-mounts, which would otherwise re-emit the same warning).
 *
 * Returns `null` when there is nothing new to alert on:
 *  - the purchase event already fired for this intent (a benign refresh), or
 *  - a gap was already reported for this intent.
 *
 * Otherwise returns the reason the event is missing — distinguishing a truly lost
 * snapshot from one that survived but holds ids that no longer resolve, so the alert
 * does not blame snapshot loss for a catalogue/data problem:
 *  - `snapshot_missing`  — neither sessionStorage nor the hardening cookie held a snapshot
 *  - `unresolvable_ids`  — a snapshot exists but its product ids did not resolve to products
 */
export function reportPurchaseGapOnce(
  paymentIntentId: string,
  storage: SimpleStorage | undefined = getDefaultStorage(),
): { reason: PurchaseGapReason } | null {
  // Purchase actually fired (e.g. user refreshed the success page) — not a gap.
  if (hasFiredPurchaseOnce(paymentIntentId, storage)) return null;

  const gapKey = `${PURCHASE_GAP_DEDUPE_PREFIX}${paymentIntentId}`;
  if (safeGetItem(storage, gapKey) === '1') return null;

  // Reaching here means the purchase never fired for this intent. If a snapshot is
  // still present, the only way it failed to fire is unresolvable ids; otherwise the
  // snapshot was lost from both sessionStorage and the hardening cookie.
  const reason: PurchaseGapReason = readCheckoutSnapshot(storage)
    ? 'unresolvable_ids'
    : 'snapshot_missing';
  safeSetItem(storage, gapKey, '1');
  return { reason };
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
    ...(options.currency ? { currency: options.currency } : {}),
    ...(options.itemPrices ? { itemPrices: options.itemPrices } : {}),
    ...(options.userData ? { userData: options.userData } : {}),
    ...(options.coupon ? { coupon: options.coupon } : {}),
    ...(options.discountMinor !== undefined ? { discountMinor: options.discountMinor } : {}),
  };
  const json = JSON.stringify(snapshot);
  safeSetItem(storage, CHECKOUT_SNAPSHOT_KEY, json);
  writeCookieSnapshot(json);
}

export function forgetRememberedCheckout(storage = getDefaultStorage()): void {
  safeRemoveItem(storage, CHECKOUT_SNAPSHOT_KEY);
  clearCookieSnapshot();
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
    currency: snapshot.currency,
    itemPrices: snapshot.itemPrices,
    userData: snapshot.userData,
    coupon: snapshot.coupon,
    discountMinor: snapshot.discountMinor,
    push: options.push,
    storage,
  });

  if (fired) forgetRememberedCheckout(storage);

  return fired;
}

function parseSnapshotJson(raw: string): CheckoutSnapshot | null {
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
      const currency =
        'currency' in parsed && (parsed.currency === 'PLN' || parsed.currency === 'EUR' || parsed.currency === 'GBP')
          ? parsed.currency
          : undefined;
      const itemPrices =
        'itemPrices' in parsed && Array.isArray(parsed.itemPrices)
          ? (parsed.itemPrices as unknown[]).filter((x): x is number => typeof x === 'number')
          : undefined;
      const userData =
        'userData' in parsed &&
        typeof parsed.userData === 'object' &&
        parsed.userData !== null
          ? (parsed.userData as { em?: string })
          : undefined;
      const coupon =
        'coupon' in parsed && typeof parsed.coupon === 'string' ? parsed.coupon : undefined;
      const discountMinor =
        'discountMinor' in parsed && typeof parsed.discountMinor === 'number'
          ? parsed.discountMinor
          : undefined;
      return {
        ids: parsed.ids.filter((id): id is string => typeof id === 'string'),
        shippingCost: parsed.shippingCost,
        shippingMethod: parsed.shippingMethod,
        ...(currency ? { currency } : {}),
        ...(itemPrices ? { itemPrices } : {}),
        ...(userData ? { userData } : {}),
        ...(coupon ? { coupon } : {}),
        ...(discountMinor !== undefined ? { discountMinor } : {}),
      };
    }
  } catch {
    // Ignore malformed snapshot data; analytics must not break the app.
  }

  return null;
}

function readCheckoutSnapshot(storage?: SimpleStorage): CheckoutSnapshot | null {
  // Try cookie first — survives iOS Safari tab eviction during cross-site redirect
  // (e.g. Przelewy24) where sessionStorage is cleared.
  const fromCookie = readCookieSnapshot();
  if (fromCookie !== null) {
    const parsed = parseSnapshotJson(fromCookie);
    if (parsed) return parsed;
  }

  const raw = safeGetItem(storage, CHECKOUT_SNAPSHOT_KEY);
  if (!raw) return null;
  return parseSnapshotJson(raw);
}

function writeCookieSnapshot(json: string): void {
  if (typeof document === 'undefined') return;
  try {
    document.cookie =
      'acc_checkout_snapshot=' +
      encodeURIComponent(json) +
      '; SameSite=Lax; Secure; Path=/; Max-Age=1800';
  } catch {
    // Best-effort: cookie writes may fail in restricted environments.
  }
}

function readCookieSnapshot(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const prefix = 'acc_checkout_snapshot=';
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) {
        return decodeURIComponent(trimmed.slice(prefix.length));
      }
    }
  } catch {
    // Best-effort: cookie reads may fail in restricted environments.
  }
  return null;
}

function clearCookieSnapshot(): void {
  if (typeof document === 'undefined') return;
  try {
    document.cookie =
      'acc_checkout_snapshot=; SameSite=Lax; Secure; Path=/; Max-Age=0';
  } catch {
    // Best-effort: cookie removal may fail in restricted environments.
  }
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
