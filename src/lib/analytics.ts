import { CATEGORIES } from './products';
import type { Product } from './types';

export const ANALYTICS_CURRENCY = 'EUR';
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
  currency: typeof ANALYTICS_CURRENCY;
  value: number;
  items: AnalyticsItem[];
  transaction_id?: string;
  shipping?: number;
};

export type MetaPayload = {
  event_name: MetaStandardEvent;
  content_ids: string[];
  content_type: 'product';
  currency: typeof ANALYTICS_CURRENCY;
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
};

type CheckoutOptions = EventOptions & {
  shippingCost: number;
  shippingMethod: string;
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
  details: { index?: number; itemListId?: string; itemListName?: string } = {},
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
    price: product.price,
    quantity: 1,
    ...(details.index !== undefined ? { index: details.index } : {}),
    ...(details.itemListId ? { item_list_id: details.itemListId } : {}),
    ...(details.itemListName ? { item_list_name: details.itemListName } : {}),
  };
}

export function buildAddToCartEvent(
  product: Product,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('add_to_cart', product.id);
  const item = toAnalyticsItem(product);
  return withMeta(
    {
      event: 'add_to_cart',
      event_id: eventId,
      ecommerce: ecommerce([item]),
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
  return {
    event: 'remove_from_cart',
    event_id: eventId,
    ecommerce: ecommerce([toAnalyticsItem(product)]),
  };
}

export function buildViewItemEvent(
  product: Product,
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string } = {},
): DataLayerEvent {
  const eventId = details.eventId ?? createEventId('view_item', product.id);
  const item = toAnalyticsItem(product, details);
  return withMeta(
    {
      event: 'view_item',
      event_id: eventId,
      ecommerce: ecommerce([item]),
    },
    'ViewContent',
    eventId,
  );
}

export function buildViewItemListEvent(
  products: Product[],
  details: { itemListId: string; itemListName: string; eventId?: string },
): DataLayerEvent {
  const items = products.map((product, index) =>
    toAnalyticsItem(product, {
      index,
      itemListId: details.itemListId,
      itemListName: details.itemListName,
    }),
  );
  return {
    event: 'view_item_list',
    event_id: details.eventId ?? createEventId('view_item_list', details.itemListId),
    ecommerce: ecommerce(items),
  };
}

export function buildSelectItemEvent(
  product: Product,
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string } = {},
): DataLayerEvent {
  return {
    event: 'select_item',
    event_id: details.eventId ?? createEventId('select_item', product.id),
    ecommerce: ecommerce([toAnalyticsItem(product, details)]),
  };
}

export function buildViewCartEvent(
  products: Product[],
  options: EventOptions = {},
): DataLayerEvent {
  return {
    event: 'view_cart',
    event_id: options.eventId ?? createEventId('view_cart', products.map((p) => p.id).join('-')),
    ecommerce: ecommerce(products.map((product) => toAnalyticsItem(product))),
  };
}

export function buildBeginCheckoutEvent(
  products: Product[],
  options: CheckoutOptions,
): DataLayerEvent {
  const eventId =
    options.eventId ?? createEventId('begin_checkout', products.map((p) => p.id).join('-'));
  const items = products.map((product) => toAnalyticsItem(product));
  const orderTotal = sumItems(items) + options.shippingCost;
  return withMeta(
    {
      event: 'begin_checkout',
      event_id: eventId,
      shipping_tier: options.shippingMethod,
      checkout_total: orderTotal,
      ecommerce: ecommerce(items),
    },
    'InitiateCheckout',
    eventId,
    orderTotal,
  );
}

export function buildPurchaseEvent(
  products: Product[],
  options: PurchaseOptions,
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('purchase', options.orderNo);
  const items = products.map((product) => toAnalyticsItem(product));
  const orderTotal = sumItems(items) + options.shippingCost;
  return withMeta(
    {
      event: 'purchase',
      event_id: eventId,
      shipping_tier: options.shippingMethod,
      order_total: orderTotal,
      ecommerce: {
        ...ecommerce(items),
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

export function buildPageViewEvent(details: {
  pageLocation: string;
  pagePath: string;
  pageTitle?: string;
  locale?: string;
}): DataLayerEvent {
  return {
    event: 'page_view',
    event_id: createEventId('page_view', details.pagePath),
    page_location: details.pageLocation,
    page_path: details.pagePath,
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

function ecommerce(items: AnalyticsItem[]): EcommercePayload {
  return {
    currency: ANALYTICS_CURRENCY,
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
      currency: ANALYTICS_CURRENCY,
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
