import { CATEGORIES, registryProductById } from './products';
import { registryPrintById } from './prints';
import { decodePrintToken, isPrintToken, variantLabel } from './print-cart';
import type { Product } from './types';
import type { CurrencyCode } from './format';

export const ANALYTICS_CURRENCY: CurrencyCode = 'PLN';
const BRAND = 'Anna Ciok Ceramics';

export type MetaStandardEvent =
  | 'ViewContent'
  | 'AddToCart'
  | 'InitiateCheckout'
  | 'Purchase';

export type AnalyticsItem = {
  item_id: string;
  item_name: string;
  item_brand: string;
  item_category: string;
  item_variant: string;
  price: number;
  quantity: 1;
  index?: number;
  item_list_id?: string;
  item_list_name?: string;
};

export type EcommercePayload = {
  currency: CurrencyCode;
  value: number;
  items: AnalyticsItem[];
  transaction_id?: string;
  shipping?: number;
  /** GA4-standard ecommerce parameter — the applied promo code, when present. */
  coupon?: string;
};

export type MetaContent = { id: string; quantity: 1; item_price: number };

export type MetaPayload = {
  event_name: MetaStandardEvent;
  content_ids: string[];
  content_type: 'product';
  contents: MetaContent[];
  currency: CurrencyCode;
  value: number;
  num_items: number;
  event_id: string;
  order_id?: string;
};

export type DataLayerEvent = {
  event: string;
  event_id?: string;
  ecommerce?: EcommercePayload;
  meta?: MetaPayload;
  app_version?: string;
  app_git_sha?: string;
  [key: string]: unknown;
};

/** GTM ecommerce reset — clear persisted items before the next ecommerce event. */
export type DataLayerEcommerceClear = { ecommerce: null };

export type DataLayerEntry = DataLayerEvent | DataLayerEcommerceClear;

type EventOptions = {
  eventId?: string;
  currency?: CurrencyCode;
  itemPrices?: number[];
};

type CheckoutOptions = EventOptions & {
  shippingCost: number;
  shippingMethod: string;
  userData?: { em?: string };
  /** Applied promo code — rendered verbatim as the GA4-standard ecommerce.coupon param. */
  coupon?: string;
  /** Discount in MINOR units (server's own unit) — converted to major units inside the builder. */
  discountMinor?: number;
};

type PurchaseOptions = CheckoutOptions & {
  orderNo: string;
};

declare global {
  interface Window {
    dataLayer?: DataLayerEntry[];
  }
}

const DEBUG_STORAGE_KEY = 'acc_analytics_debug';

export function toAnalyticsItem(
  product: Product,
  details: { index?: number; itemListId?: string; itemListName?: string; priceOverride?: number } = {},
): AnalyticsItem {
  const category = CATEGORIES[product.category];
  const singularLabel =
    category.singularKey.charAt(0).toUpperCase() + category.singularKey.slice(1);
  return {
    item_id: product.id,
    item_name: `${singularLabel} Nº ${product.num}`,
    item_brand: BRAND,
    item_category: product.category,
    item_variant: `Nº ${product.num}`,
    price: details.priceOverride ?? product.price,
    quantity: 1,
    ...(details.index !== undefined ? { index: details.index } : {}),
    ...(details.itemListId ? { item_list_id: details.itemListId } : {}),
    ...(details.itemListName ? { item_list_name: details.itemListName } : {}),
  };
}

/**
 * Resolve a cart id — a bare ceramic id (`k01`) or a print token
 * (`print:fap01:a3:satin:oak`) — to an AnalyticsItem, or null if unresolvable.
 * Lets the cart/checkout/purchase events itemise prints alongside ceramics.
 */
export function analyticsItemForId(id: string, priceOverride?: number): AnalyticsItem | null {
  if (isPrintToken(id)) {
    const dec = decodePrintToken(id);
    if (!dec) return null;
    const design = registryPrintById(dec.designId);
    if (!design) return null;
    // A print has no single catalogue price — without the caller-supplied price
    // a 0 would silently understate cart/purchase values, so drop the item.
    if (priceOverride === undefined) return null;
    return {
      item_id: design.id,
      item_name: `Print Nº ${design.num}`,
      item_brand: BRAND,
      item_category: 'fine-art-prints',
      item_variant: variantLabel(dec.sel, 'en'),
      price: priceOverride,
      quantity: 1,
    };
  }
  const product = registryProductById(id);
  if (!product) return null;
  return toAnalyticsItem(product, { priceOverride });
}

/** Resolve a positional ids + prices pair to AnalyticsItems, dropping unresolvable ids. */
export function analyticsItemsForIds(ids: string[], itemPrices?: number[]): AnalyticsItem[] {
  return ids
    .map((id, i) => analyticsItemForId(id, itemPrices?.[i]))
    .filter((it): it is AnalyticsItem => it !== null);
}

export function buildAddToCartEvent(
  product: Product,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('add_to_cart', product.id);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  const item = toAnalyticsItem(product, { priceOverride: options.itemPrices?.[0] });
  return withMeta(
    {
      event: 'add_to_cart',
      event_id: eventId,
      ecommerce: ecommerce([item], currency),
    },
    'AddToCart',
    eventId,
  );
}

type PrintItemInput = { id: string; num: string; variantLabel: string; price: number };

/** One canonical AnalyticsItem shape for a print variant (item_id = design id,
 *  so Meta content_ids / GA4 item_id match the fap0x merchant-feed rows). */
function printAnalyticsItem(print: PrintItemInput): AnalyticsItem {
  return {
    item_id: print.id,
    item_name: `Print Nº ${print.num}`,
    item_brand: BRAND,
    item_category: 'fine-art-prints',
    item_variant: print.variantLabel,
    price: print.price,
    quantity: 1,
  };
}

/**
 * add_to_cart for a fine-art print variant. Prints aren't `Product`s, so this
 * builds the AnalyticsItem via printAnalyticsItem: item_id = design id,
 * item_variant = the chosen size/frame label, price = resolved variant price.
 */
export function buildPrintAddToCartEvent(
  print: PrintItemInput,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('add_to_cart', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  return withMeta(
    {
      event: 'add_to_cart',
      event_id: eventId,
      ecommerce: ecommerce([printAnalyticsItem(print)], currency),
    },
    'AddToCart',
    eventId,
  );
}

/** view_item for a print PDP — mirrors buildViewItemEvent (GA4 + Meta ViewContent). */
export function buildPrintViewItemEvent(
  print: PrintItemInput,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('view_item', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  return withMeta(
    {
      event: 'view_item',
      event_id: eventId,
      ecommerce: ecommerce([printAnalyticsItem(print)], currency),
    },
    'ViewContent',
    eventId,
  );
}

/** view_item_list for the print collection — GA4-only, mirrors buildViewItemListEvent. */
export function buildPrintViewItemListEvent(
  prints: PrintItemInput[],
  details: { itemListId: string; itemListName: string; eventId?: string; currency?: CurrencyCode },
): DataLayerEvent {
  const items = prints.map((print, index) => ({
    ...printAnalyticsItem(print),
    index,
    item_list_id: details.itemListId,
    item_list_name: details.itemListName,
  }));
  return {
    event: 'view_item_list',
    event_id: details.eventId ?? createEventId('view_item_list', details.itemListId),
    ecommerce: ecommerce(items, details.currency),
  };
}

/** select_item for a print tile — GA4-only, mirrors buildSelectItemEvent. */
export function buildPrintSelectItemEvent(
  print: PrintItemInput,
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string; currency?: CurrencyCode } = {},
): DataLayerEvent {
  const item: AnalyticsItem = {
    ...printAnalyticsItem(print),
    ...(details.index !== undefined ? { index: details.index } : {}),
    ...(details.itemListId ? { item_list_id: details.itemListId } : {}),
    ...(details.itemListName ? { item_list_name: details.itemListName } : {}),
  };
  return {
    event: 'select_item',
    event_id: details.eventId ?? createEventId('select_item', print.id),
    ecommerce: ecommerce([item], details.currency),
  };
}

/** remove_from_cart for a print variant — GA4-only, mirrors buildRemoveFromCartEvent. */
export function buildPrintRemoveFromCartEvent(
  print: PrintItemInput,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('remove_from_cart', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  return {
    event: 'remove_from_cart',
    event_id: eventId,
    ecommerce: ecommerce([printAnalyticsItem(print)], currency),
  };
}

export function buildRemoveFromCartEvent(
  product: Product,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('remove_from_cart', product.id);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  const item = toAnalyticsItem(product, { priceOverride: options.itemPrices?.[0] });
  return {
    event: 'remove_from_cart',
    event_id: eventId,
    ecommerce: ecommerce([item], currency),
  };
}

export function buildViewItemEvent(
  product: Product,
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string; currency?: CurrencyCode; priceOverride?: number } = {},
): DataLayerEvent {
  const eventId = details.eventId ?? createEventId('view_item', product.id);
  const item = toAnalyticsItem(product, details);
  return withMeta(
    {
      event: 'view_item',
      event_id: eventId,
      ecommerce: ecommerce([item], details.currency),
    },
    'ViewContent',
    eventId,
  );
}

export function buildViewItemListEvent(
  products: Product[],
  details: { itemListId: string; itemListName: string; eventId?: string; currency?: CurrencyCode; itemPrices?: number[] },
): DataLayerEvent {
  const items = products.map((product, index) =>
    toAnalyticsItem(product, {
      index,
      itemListId: details.itemListId,
      itemListName: details.itemListName,
      priceOverride: details.itemPrices?.[index],
    }),
  );
  return {
    event: 'view_item_list',
    event_id: details.eventId ?? createEventId('view_item_list', details.itemListId),
    ecommerce: ecommerce(items, details.currency),
  };
}

export function buildSelectItemEvent(
  product: Product,
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string; currency?: CurrencyCode; priceOverride?: number } = {},
): DataLayerEvent {
  return {
    event: 'select_item',
    event_id: details.eventId ?? createEventId('select_item', product.id),
    ecommerce: ecommerce([toAnalyticsItem(product, details)], details.currency),
  };
}

/** view_cart from pre-resolved AnalyticsItems (ceramics + prints). */
export function buildViewCartEventFromItems(
  items: AnalyticsItem[],
  options: { currency?: CurrencyCode; eventId?: string } = {},
): DataLayerEvent {
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  return {
    event: 'view_cart',
    event_id: options.eventId ?? createEventId('view_cart', items.map((i) => i.item_id).join('-')),
    ecommerce: ecommerce(items, currency),
  };
}

export function buildViewCartEvent(
  products: Product[],
  options: EventOptions = {},
): DataLayerEvent {
  const items = products.map((product, i) =>
    toAnalyticsItem(product, { priceOverride: options.itemPrices?.[i] }),
  );
  return buildViewCartEventFromItems(items, { currency: options.currency, eventId: options.eventId });
}

/** begin_checkout from pre-resolved AnalyticsItems (ceramics + prints). */
export function buildBeginCheckoutEventFromItems(
  items: AnalyticsItem[],
  options: CheckoutOptions,
): DataLayerEvent {
  const eventId =
    options.eventId ?? createEventId('begin_checkout', items.map((i) => i.item_id).join('-'));
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  // No-discount path stays the EXACT expression used before promo codes existed
  // (byte-identical regression) — the rounding pass only kicks in once a
  // discount is actually subtracted, so it can never introduce float dust for
  // the vast majority of (non-promo) checkouts.
  const discountMajor = options.discountMinor ? options.discountMinor / 100 : 0;
  const subtotal =
    discountMajor > 0 ? Number((sumItems(items) - discountMajor).toFixed(2)) : sumItems(items);
  const orderTotal = subtotal + options.shippingCost;
  return withMeta(
    {
      event: 'begin_checkout',
      event_id: eventId,
      shipping_tier: options.shippingMethod,
      checkout_total: orderTotal,
      ...(options.userData ? { user_data: options.userData } : {}),
      ecommerce: {
        ...ecommerce(items, currency),
        value: subtotal,
        ...(options.coupon ? { coupon: options.coupon } : {}),
      },
    },
    'InitiateCheckout',
    eventId,
    orderTotal,
  );
}

export function buildBeginCheckoutEvent(
  products: Product[],
  options: CheckoutOptions,
): DataLayerEvent {
  const items = products.map((product, i) =>
    toAnalyticsItem(product, { priceOverride: options.itemPrices?.[i] }),
  );
  return buildBeginCheckoutEventFromItems(items, options);
}

/** purchase from pre-resolved AnalyticsItems (ceramics + prints). */
export function buildPurchaseEventFromItems(
  items: AnalyticsItem[],
  options: PurchaseOptions,
): DataLayerEvent {
  // Deterministic id (no random suffix): a purchase is a single conversion, so
  // the browser event_id must be reproducible server-side from the orderNo —
  // that shared id is what lets a Meta CAPI / GA4 Measurement Protocol replay
  // from the Stripe webhook deduplicate against this browser event. The client
  // already fires at most once per payment intent (acc_purchase_pi: guard in
  // checkout-analytics.ts), so collision-resistance here is unnecessary.
  const eventId = options.eventId ?? `purchase-${options.orderNo}`;
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  // Same byte-identical-when-no-discount rule as begin_checkout above.
  const discountMajor = options.discountMinor ? options.discountMinor / 100 : 0;
  const subtotal =
    discountMajor > 0 ? Number((sumItems(items) - discountMajor).toFixed(2)) : sumItems(items);
  const orderTotal = subtotal + options.shippingCost;
  return withMeta(
    {
      event: 'purchase',
      event_id: eventId,
      shipping_tier: options.shippingMethod,
      order_total: orderTotal,
      ...(options.userData ? { user_data: options.userData } : {}),
      ecommerce: {
        ...ecommerce(items, currency),
        value: subtotal,
        ...(options.coupon ? { coupon: options.coupon } : {}),
        transaction_id: options.orderNo,
        shipping: options.shippingCost,
      },
    },
    'Purchase',
    eventId,
    orderTotal,
    options.orderNo,
  );
}

export function buildPurchaseEvent(
  products: Product[],
  options: PurchaseOptions,
): DataLayerEvent {
  const items = products.map((product, i) =>
    toAnalyticsItem(product, { priceOverride: options.itemPrices?.[i] }),
  );
  return buildPurchaseEventFromItems(items, options);
}

export function buildEngagementEvent(
  engagementType: string,
  properties: Record<string, unknown> = {},
): DataLayerEvent {
  return {
    event: 'site_engagement',
    event_id: createEventId('site_engagement', engagementType),
    engagement_type: engagementType,
    ...properties,
  };
}

export type AuthMethod = 'google' | 'apple';

/**
 * login / sign_up dataLayer events. `user_id` is the opaque Supabase user id
 * (a random UUID, not PII) — emitted so GTM can set GA4's user_id for the
 * session; `method` is the OAuth provider. No ecommerce/meta payload.
 */
export function buildLoginEvent(method: AuthMethod, userId: string): DataLayerEvent {
  return { event: 'login', event_id: createEventId('login', userId), method, user_id: userId };
}

export function buildSignUpEvent(method: AuthMethod, userId: string): DataLayerEvent {
  return { event: 'sign_up', event_id: createEventId('sign_up', userId), method, user_id: userId };
}

/** Query params that carry a capability token / secret and must never reach the
 *  dataLayer (and thus GA4 / Meta). `order` is the return capability token used by
 *  /zwrot?order=<uuid> → POST /api/returns. `payment_intent` /
 *  `payment_intent_client_secret` are appended by Stripe to the /koszyk/return URL
 *  and must not be logged or exposed to third parties. `sale` is the single-use
 *  private-sale re-offer token (/koszyk?sale=<token>). `preview` is the admin
 *  CMS draft-preview token minted for unpublished product notes. */
const SENSITIVE_QUERY_PARAMS = [
  'order',
  'payment_intent',
  'payment_intent_client_secret',
  'sale',
  'preview',
];

/** Redact sensitive query params from an absolute or path-only URL before it is
 *  pushed to analytics. Returns the input unchanged if it has no sensitive param
 *  or can't be parsed. */
export function redactSensitiveUrl(value: string): string {
  try {
    const hasOrigin = /^[a-z]+:\/\//i.test(value);
    const url = new URL(value, 'https://redacted.local');
    let changed = false;
    for (const key of SENSITIVE_QUERY_PARAMS) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, 'redacted');
        changed = true;
      }
    }
    if (!changed) return value;
    return hasOrigin ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

export function buildPageViewEvent(details: {
  pageLocation: string;
  pagePath: string;
  pageTitle?: string;
  locale?: string;
}): DataLayerEvent {
  const pagePath = redactSensitiveUrl(details.pagePath);
  return {
    event: 'page_view',
    event_id: createEventId('page_view', pagePath),
    page_location: redactSensitiveUrl(details.pageLocation),
    page_path: pagePath,
    page_title: details.pageTitle,
    locale: details.locale,
  };
}

export function pushDataLayer(event: DataLayerEvent): void {
  if (typeof window === 'undefined') return;
  window.dataLayer = window.dataLayer ?? [];
  // Reset GTM's persisted ecommerce object so a prior view_item_list does not
  // merge its items into purchase / checkout / cart events in Tag Assistant or GA4.
  if (event.ecommerce) {
    window.dataLayer.push({ ecommerce: null });
  }
  // Stamped on every event so GA4 rows are attributable to the deploy that sent
  // them — same NEXT_PUBLIC_APP_VERSION/NEXT_PUBLIC_GIT_SHA the Sentry release and
  // admin badge already use (next.config.ts).
  const payload: DataLayerEvent = {
    ...event,
    app_version: process.env.NEXT_PUBLIC_APP_VERSION,
    app_git_sha: process.env.NEXT_PUBLIC_GIT_SHA,
  };
  window.dataLayer.push(payload);
  mirrorDebugEvent(payload);
}

function mirrorDebugEvent(event: DataLayerEvent): void {
  if (!isDebugHost()) return;

  try {
    const current = JSON.parse(window.sessionStorage.getItem(DEBUG_STORAGE_KEY) ?? '[]') as unknown;
    const events = Array.isArray(current) ? current : [];
    events.push({
      event: event.event,
      engagement_type: event.engagement_type,
      ecommerce: Boolean(event.ecommerce),
      meta: Boolean(event.meta),
    });
    window.sessionStorage.setItem(DEBUG_STORAGE_KEY, JSON.stringify(events.slice(-50)));
    window.document.documentElement.dataset.accAnalyticsDebug = events
      .slice(-20)
      .map((entry) =>
        typeof entry === 'object' && entry !== null && 'event' in entry
          ? `${String(entry.event)}:${String(
              'engagement_type' in entry ? entry.engagement_type ?? '' : '',
            )}`
          : 'unknown:',
      )
      .join('|');
  } catch {
    // Analytics must never break the storefront if browser storage is unavailable.
  }
}

function isDebugHost(): boolean {
  return (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    process.env.NODE_ENV !== 'production'
  );
}

function ecommerce(items: AnalyticsItem[], currency: CurrencyCode = ANALYTICS_CURRENCY): EcommercePayload {
  return {
    currency,
    value: sumItems(items),
    items,
  };
}

function withMeta(
  event: DataLayerEvent,
  eventName: MetaStandardEvent,
  eventId: string,
  metaValue = event.ecommerce?.value ?? 0,
  orderId?: string,
): DataLayerEvent {
  const items = event.ecommerce?.items ?? [];
  return {
    ...event,
    meta: {
      event_name: eventName,
      content_ids: items.map((item) => item.item_id),
      content_type: 'product',
      contents: items.map((item) => ({ id: item.item_id, quantity: 1 as const, item_price: item.price })),
      currency: event.ecommerce?.currency ?? ANALYTICS_CURRENCY,
      value: metaValue,
      num_items: items.length,
      event_id: eventId,
      ...(orderId ? { order_id: orderId } : {}),
    },
  };
}

function sumItems(items: AnalyticsItem[]): number {
  return Number(items.reduce((sum, item) => sum + item.price * item.quantity, 0).toFixed(2));
}

function createEventId(eventName: string, seed: string): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${eventName}-${seed}-${suffix}`;
}
