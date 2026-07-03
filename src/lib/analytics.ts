import { CATEGORIES, getProductById } from './products';
import { getPrintById } from './prints';
import { decodePrintToken, isPrintToken, variantLabel } from './print-cart';
import type { Product } from './types';

export const ANALYTICS_CURRENCY = 'PLN';
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
  currency: 'PLN' | 'EUR' | 'GBP';
  value: number;
  items: AnalyticsItem[];
  transaction_id?: string;
  shipping?: number;
};

export type MetaContent = { id: string; quantity: 1; item_price: number };

export type MetaPayload = {
  event_name: MetaStandardEvent;
  content_ids: string[];
  content_type: 'product';
  contents: MetaContent[];
  currency: 'PLN' | 'EUR' | 'GBP';
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
  [key: string]: unknown;
};

/** GTM ecommerce reset — clear persisted items before the next ecommerce event. */
export type DataLayerEcommerceClear = { ecommerce: null };

export type DataLayerEntry = DataLayerEvent | DataLayerEcommerceClear;

type EventOptions = {
  eventId?: string;
  currency?: 'PLN' | 'EUR' | 'GBP';
  itemPrices?: number[];
};

type CheckoutOptions = EventOptions & {
  shippingCost: number;
  shippingMethod: string;
  userData?: { em?: string };
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
    const design = getPrintById(dec.designId);
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
  const product = getProductById(id);
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

/**
 * add_to_cart for a fine-art print variant. Prints aren't `Product`s, so this
 * builds the AnalyticsItem directly: item_id = design id, item_variant = the
 * chosen size/paper/frame label, price = the resolved variant price (major units).
 */
export function buildPrintAddToCartEvent(
  print: { id: string; num: string; variantLabel: string; price: number },
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('add_to_cart', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  const item: AnalyticsItem = {
    item_id: print.id,
    item_name: `Print Nº ${print.num}`,
    item_brand: BRAND,
    item_category: 'fine-art-prints',
    item_variant: print.variantLabel,
    price: print.price,
    quantity: 1,
  };
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
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string; currency?: 'PLN' | 'EUR' | 'GBP'; priceOverride?: number } = {},
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
  details: { itemListId: string; itemListName: string; eventId?: string; currency?: 'PLN' | 'EUR' | 'GBP'; itemPrices?: number[] },
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
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string; currency?: 'PLN' | 'EUR' | 'GBP'; priceOverride?: number } = {},
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
  options: { currency?: 'PLN' | 'EUR' | 'GBP'; eventId?: string } = {},
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
  const orderTotal = sumItems(items) + options.shippingCost;
  return withMeta(
    {
      event: 'begin_checkout',
      event_id: eventId,
      shipping_tier: options.shippingMethod,
      checkout_total: orderTotal,
      ...(options.userData ? { user_data: options.userData } : {}),
      ecommerce: ecommerce(items, currency),
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
  const orderTotal = sumItems(items) + options.shippingCost;
  return withMeta(
    {
      event: 'purchase',
      event_id: eventId,
      shipping_tier: options.shippingMethod,
      order_total: orderTotal,
      ...(options.userData ? { user_data: options.userData } : {}),
      ecommerce: {
        ...ecommerce(items, currency),
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

/** Query params that carry a capability token / secret and must never reach the
 *  dataLayer (and thus GA4 / Meta). `order` is the return capability token used by
 *  /zwrot?order=<uuid> → POST /api/returns. `payment_intent` /
 *  `payment_intent_client_secret` are appended by Stripe to the /koszyk/return URL
 *  and must not be logged or exposed to third parties. */
const SENSITIVE_QUERY_PARAMS = ['order', 'payment_intent', 'payment_intent_client_secret'];

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
  window.dataLayer.push(event);
  mirrorDebugEvent(event);
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

function ecommerce(items: AnalyticsItem[], currency: 'PLN' | 'EUR' | 'GBP' = ANALYTICS_CURRENCY): EcommercePayload {
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
