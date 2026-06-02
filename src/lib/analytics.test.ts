import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProductById } from './products';
import {
  ANALYTICS_CURRENCY,
  buildAddToCartEvent,
  buildBeginCheckoutEvent,
  buildEngagementEvent,
  buildPageViewEvent,
  buildPurchaseEvent,
  pushDataLayer,
  toAnalyticsItem,
} from './analytics';

const product = (id: string) => {
  const found = getProductById(id);
  if (!found) throw new Error(`Missing product fixture: ${id}`);
  return found;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('analytics ecommerce payloads', () => {
  it('maps one-of-a-kind products to GA4 item shape', () => {
    expect(toAnalyticsItem(product('k01'))).toEqual({
      item_id: 'k01',
      item_name: 'kubki Nº 01',
      item_brand: 'Anna Ciok Ceramics',
      item_category: 'kubki',
      item_variant: 'Nº 01',
      price: 22,
      quantity: 1,
    });
  });

  it('builds add_to_cart with GA4 ecommerce data and Meta standard-event mapping', () => {
    const event = buildAddToCartEvent(product('k01'), { eventId: 'evt-atc-k01' });

    expect(event).toMatchObject({
      event: 'add_to_cart',
      event_id: 'evt-atc-k01',
      ecommerce: {
        currency: ANALYTICS_CURRENCY,
        value: 22,
        items: [toAnalyticsItem(product('k01'))],
      },
      meta: {
        event_name: 'AddToCart',
        content_ids: ['k01'],
        content_type: 'product',
        currency: ANALYTICS_CURRENCY,
        value: 22,
        num_items: 1,
        event_id: 'evt-atc-k01',
      },
    });
  });

  it('builds begin_checkout with item subtotal for GA4 and order total for Meta', () => {
    const items = [product('k01'), product('v01')];
    const event = buildBeginCheckoutEvent(items, {
      eventId: 'evt-checkout',
      shippingCost: 18,
      shippingMethod: 'kurier',
    });

    expect(event.ecommerce.value).toBe(72);
    expect(event.checkout_total).toBe(90);
    expect(event.shipping_tier).toBe('kurier');
    expect(event.meta).toMatchObject({
      event_name: 'InitiateCheckout',
      content_ids: ['k01', 'v01'],
      value: 90,
      num_items: 2,
      event_id: 'evt-checkout',
    });
  });

  it('builds purchase with transaction id, shipping, subtotal and Meta Purchase value', () => {
    const items = [product('k01'), product('v01')];
    const event = buildPurchaseEvent(items, {
      orderNo: 'ACC-1234',
      shippingCost: 18,
      shippingMethod: 'kurier',
    });

    expect(event.event).toBe('purchase');
    expect(event.event_id).toBe('purchase-ACC-1234');
    expect(event.ecommerce).toMatchObject({
      transaction_id: 'ACC-1234',
      currency: ANALYTICS_CURRENCY,
      value: 72,
      shipping: 18,
      items: items.map(toAnalyticsItem),
    });
    expect(event.order_total).toBe(90);
    expect(event.meta).toMatchObject({
      event_name: 'Purchase',
      content_ids: ['k01', 'v01'],
      currency: ANALYTICS_CURRENCY,
      value: 90,
      order_id: 'ACC-1234',
      event_id: 'purchase-ACC-1234',
    });
  });
});

describe('analytics engagement payloads', () => {
  it('keeps engagement events explicit and GTM-friendly', () => {
    expect(
      buildEngagementEvent('language_change', {
        from_locale: 'pl',
        to_locale: 'en',
      }),
    ).toMatchObject({
      event: 'site_engagement',
      engagement_type: 'language_change',
      from_locale: 'pl',
      to_locale: 'en',
    });
  });
});

describe('buildPageViewEvent', () => {
  it('includes a non-empty event_id so Meta PageView can deduplicate', () => {
    const event = buildPageViewEvent({
      pageLocation: 'https://example.com/en/kubki',
      pagePath: '/en/kubki',
      pageTitle: 'Mugs',
      locale: 'en',
    });

    expect(event.event).toBe('page_view');
    expect(typeof event.event_id).toBe('string');
    expect(event.event_id).not.toBe('');
  });
});

describe('pushDataLayer', () => {
  it('pushes to dataLayer and mirrors localhost events to the QA debug buffer', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      dataLayer: [],
      document: {
        documentElement: {
          dataset: {},
        },
      },
      location: { hostname: 'localhost' },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    const event = buildEngagementEvent('language_change', { to_locale: 'en' });
    pushDataLayer(event);

    expect(window.dataLayer).toEqual([event]);
    expect(JSON.parse(storage.get('acc_analytics_debug') ?? '[]')).toEqual([
      {
        event: 'site_engagement',
        engagement_type: 'language_change',
        ecommerce: false,
        meta: false,
      },
    ]);
    expect(window.document.documentElement.dataset.accAnalyticsDebug).toBe(
      'site_engagement:language_change',
    );
  });
});
