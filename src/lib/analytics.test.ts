import { afterEach, describe, expect, it, vi } from 'vitest';
import { registryProductById } from './products';
import {
  ANALYTICS_CURRENCY,
  allocateItemDiscounts,
  analyticsItemForId,
  buildAddToCartEvent,
  buildBeginCheckoutEvent,
  buildEngagementEvent,
  buildLoginEvent,
  buildPageViewEvent,
  buildPrintAddToCartEvent,
  buildPrintRemoveFromCartEvent,
  buildPrintSelectItemEvent,
  buildPrintViewItemEvent,
  buildPrintViewItemListEvent,
  buildPurchaseEvent,
  buildRemoveFromCartEvent,
  buildSelectItemEvent,
  buildSignUpEvent,
  buildViewItemEvent,
  buildViewItemListEvent,
  pushDataLayer,
  redactSensitiveUrl,
  toAnalyticsItem,
} from './analytics';

const product = (id: string) => {
  const found = registryProductById(id);
  if (!found) throw new Error(`Missing product fixture: ${id}`);
  return found;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('redactSensitiveUrl', () => {
  it('redacts the order capability token from absolute and relative urls', () => {
    expect(redactSensitiveUrl('https://anna-ciok.studio/zwrot?order=abc-123')).toBe(
      'https://anna-ciok.studio/zwrot?order=redacted',
    );
    expect(redactSensitiveUrl('/zwrot?order=abc-123')).toBe('/zwrot?order=redacted');
  });
  it('redacts the Stripe payment_intent secret from the return url', () => {
    expect(
      redactSensitiveUrl(
        '/pl/koszyk/return?payment_intent=pi_123&payment_intent_client_secret=pi_123_secret_xyz&redirect_status=succeeded',
      ),
    ).toBe(
      '/pl/koszyk/return?payment_intent=redacted&payment_intent_client_secret=redacted&redirect_status=succeeded',
    );
  });
  it('redacts the private-sale token from absolute and relative urls', () => {
    expect(redactSensitiveUrl('https://anna-ciok.studio/koszyk?sale=abc-123')).toBe(
      'https://anna-ciok.studio/koszyk?sale=redacted',
    );
    expect(redactSensitiveUrl('/koszyk?sale=abc-123')).toBe('/koszyk?sale=redacted');
  });
  it('redacts the CMS draft-preview token from absolute and relative urls', () => {
    expect(
      redactSensitiveUrl('https://anna-ciok.studio/kubki/k01?preview=eyJhbGciOiJIUzI1NiJ9'),
    ).toBe('https://anna-ciok.studio/kubki/k01?preview=redacted');
    expect(redactSensitiveUrl('/kubki/k01?preview=eyJhbGciOiJIUzI1NiJ9')).toBe(
      '/kubki/k01?preview=redacted',
    );
  });
  it('leaves non-sensitive urls unchanged', () => {
    expect(redactSensitiveUrl('/pl/koszyk')).toBe('/pl/koszyk');
    expect(redactSensitiveUrl('https://anna-ciok.studio/pl')).toBe('https://anna-ciok.studio/pl');
  });
});

describe('buildPageViewEvent redaction', () => {
  it('strips the order token from page_location and page_path', () => {
    const e = buildPageViewEvent({
      pageLocation: 'https://anna-ciok.studio/zwrot?order=abc-123',
      pagePath: '/zwrot?order=abc-123',
    });
    expect(e.page_location).toBe('https://anna-ciok.studio/zwrot?order=redacted');
    expect(e.page_path).toBe('/zwrot?order=redacted');
    expect(JSON.stringify(e)).not.toContain('abc-123');
  });

  it('strips the sale token from page_location and page_path', () => {
    const e = buildPageViewEvent({
      pageLocation: 'https://anna-ciok.studio/koszyk?sale=abc-123',
      pagePath: '/koszyk?sale=abc-123',
    });
    expect(e.page_location).toBe('https://anna-ciok.studio/koszyk?sale=redacted');
    expect(e.page_path).toBe('/koszyk?sale=redacted');
    expect(JSON.stringify(e)).not.toContain('abc-123');
  });
});

describe('analytics ecommerce payloads', () => {
  it('maps one-of-a-kind products to GA4 item shape', () => {
    expect(toAnalyticsItem(product('k01'))).toEqual({
      item_id: 'k01',
      item_name: 'Mug Nº 01',
      item_brand: 'Anna Ciok Ceramics',
      item_category: 'kubki',
      item_variant: 'Nº 01',
      price: 95,
      quantity: 1,
    });
  });

  it('derives stable locale-independent item_name from singularKey for hyphenated categories', () => {
    // wazony-duze → singularKey 'bigvase'. d06 keeps its id but is now Nº 01.
    const bigvaseProduct = product('d06');
    expect(bigvaseProduct.category).toBe('wazony-duze');
    const bigvaseItem = toAnalyticsItem(bigvaseProduct);
    expect(bigvaseItem.item_name).toBe('Bigvase Nº 01');
    expect(bigvaseItem.item_category).toBe('wazony-duze');
    expect(bigvaseItem.item_variant).toBe('Nº 01');

    // miski-falowane → singularKey 'wavybowl'. w17 keeps its id, now Nº 10.
    const wavybowlProduct = product('w17');
    expect(wavybowlProduct.category).toBe('miski-falowane');
    const wavybowlItem = toAnalyticsItem(wavybowlProduct);
    expect(wavybowlItem.item_name).toBe('Wavybowl Nº 10');
    expect(wavybowlItem.item_category).toBe('miski-falowane');
    expect(wavybowlItem.item_variant).toBe('Nº 10');
  });

  it('item_category equals product.category directly (no round-trip indirection)', () => {
    // vase: singularKey 'vase', category 'wazony'
    const vaseItem = toAnalyticsItem(product('v01'));
    expect(vaseItem.item_category).toBe('wazony');
    expect(vaseItem.item_name).toBe('Vase Nº 01');

    // talerzyki: singularKey 'dish', category 'talerzyki'
    const dishItem = toAnalyticsItem(product('t01'));
    expect(dishItem.item_category).toBe('talerzyki');
    expect(dishItem.item_name).toBe('Dish Nº 01');
  });

  it('preserves item_id, price, quantity, and optional details fields', () => {
    const item = toAnalyticsItem(product('k01'), {
      index: 3,
      itemListId: 'collection-kubki',
      itemListName: 'Kubki',
    });
    expect(item.item_id).toBe('k01');
    expect(item.price).toBe(95);
    expect(item.quantity).toBe(1);
    expect(item.index).toBe(3);
    expect(item.item_list_id).toBe('collection-kubki');
    expect(item.item_list_name).toBe('Kubki');
  });

  it('builds add_to_cart with GA4 ecommerce data and Meta standard-event mapping', () => {
    const event = buildAddToCartEvent(product('k01'), { eventId: 'evt-atc-k01' });

    expect(event).toMatchObject({
      event: 'add_to_cart',
      event_id: 'evt-atc-k01',
      ecommerce: {
        currency: ANALYTICS_CURRENCY,
        value: 95,
        items: [toAnalyticsItem(product('k01'))],
      },
      meta: {
        event_name: 'AddToCart',
        content_ids: ['k01'],
        content_type: 'product',
        contents: [{ id: 'k01', quantity: 1, item_price: 95 }],
        currency: ANALYTICS_CURRENCY,
        value: 95,
        num_items: 1,
        event_id: 'evt-atc-k01',
      },
    });
  });

  it('includes a Meta contents[] array with per-item price/quantity', () => {
    const event = buildAddToCartEvent(product('k01'), { eventId: 'evt-atc-k01' });
    expect(event.meta?.contents).toEqual([{ id: 'k01', quantity: 1, item_price: 95 }]);
  });

  it('builds begin_checkout with item subtotal for GA4 and order total for Meta', () => {
    const items = [product('k01'), product('v01')];
    const event = buildBeginCheckoutEvent(items, {
      eventId: 'evt-checkout',
      shippingCost: 18,
      shippingMethod: 'kurier',
    });

    expect(event.ecommerce?.value).toBe(334);
    expect(event.checkout_total).toBe(352);
    expect(event.shipping_tier).toBe('kurier');
    expect(event.meta).toMatchObject({
      event_name: 'InitiateCheckout',
      content_ids: ['k01', 'v01'],
      contents: [
        { id: 'k01', quantity: 1, item_price: 95 },
        { id: 'v01', quantity: 1, item_price: 239 },
      ],
      value: 352,
      num_items: 2,
      event_id: 'evt-checkout',
    });
  });

  it('uses EUR currency and EUR item prices when currency option is EUR', () => {
    const items = [product('k01')];
    const event = buildBeginCheckoutEvent(items, {
      eventId: 'evt-eur',
      shippingCost: 5,
      shippingMethod: 'paczkomat',
      currency: 'EUR',
      itemPrices: [22],
    });

    expect(event.ecommerce).toMatchObject({
      currency: 'EUR',
      value: 22,
      items: [expect.objectContaining({ price: 22 })],
    });
    expect(event.meta).toMatchObject({
      currency: 'EUR',
      value: 27,
    });
  });

  it('attaches hashed user_data to begin_checkout when provided', () => {
    const e = buildBeginCheckoutEvent([product('k01')], {
      shippingCost: 18, shippingMethod: 'kurier', eventId: 'evt-bc',
      userData: { em: 'HASH_EM' },
    });
    expect(e.user_data).toEqual({ em: 'HASH_EM' });
  });

  it('builds purchase with transaction id, shipping, subtotal and Meta Purchase value', () => {
    const items = [product('k01'), product('v01')];
    const event = buildPurchaseEvent(items, {
      orderNo: 'ACC-1234',
      shippingCost: 18,
      shippingMethod: 'kurier',
      eventId: 'evt-purchase',
    });

    expect(event.event).toBe('purchase');
    expect(event.event_id).toBe('evt-purchase');
    expect(event.ecommerce).toMatchObject({
      transaction_id: 'ACC-1234',
      currency: ANALYTICS_CURRENCY,
      value: 334,
      shipping: 18,
      items: items.map((p) => toAnalyticsItem(p)),
    });
    expect(event.order_total).toBe(352);
    expect(event.meta).toMatchObject({
      event_name: 'Purchase',
      content_ids: ['k01', 'v01'],
      contents: [
        { id: 'k01', quantity: 1, item_price: 95 },
        { id: 'v01', quantity: 1, item_price: 239 },
      ],
      currency: ANALYTICS_CURRENCY,
      value: 352,
      order_id: 'ACC-1234',
      event_id: 'evt-purchase',
    });
  });

  it('promo: coupon + discountMinor apply to begin_checkout ecommerce.value and checkout_total', () => {
    const items = [product('k01'), product('v01')];
    const event = buildBeginCheckoutEvent(items, {
      eventId: 'evt-checkout-promo',
      shippingCost: 18,
      shippingMethod: 'kurier',
      coupon: 'WELCOME10',
      discountMinor: 3400, // 34 zł
    });

    expect(event.ecommerce).toMatchObject({ value: 300, coupon: 'WELCOME10' });
    expect(event.checkout_total).toBe(318);
    expect(event.meta).toMatchObject({ value: 318 });
    // Discount must be allocated across items, not just the order-level value —
    // otherwise GA4/Meta per-item revenue wouldn't sum to the discounted total.
    const [k01Item, v01Item] = event.ecommerce!.items;
    expect(k01Item).toMatchObject({ price: 85.33, discount: 9.67 });
    expect(v01Item).toMatchObject({ price: 214.67, discount: 24.33 });
    expect(k01Item.price + v01Item.price).toBeCloseTo(300, 2);
    expect(event.meta!.contents).toEqual([
      { id: 'k01', quantity: 1, item_price: 85.33 },
      { id: 'v01', quantity: 1, item_price: 214.67 },
    ]);
  });

  it('promo: with no coupon/discountMinor, begin_checkout is byte-identical to the no-promo build (regression)', () => {
    const items = [product('k01'), product('v01')];
    const base = { eventId: 'evt-checkout', shippingCost: 18, shippingMethod: 'kurier' };
    const withPromoFieldsAbsent = buildBeginCheckoutEvent(items, base);
    const legacy = buildBeginCheckoutEvent(items, base);
    expect(withPromoFieldsAbsent).toEqual(legacy);
    expect(withPromoFieldsAbsent.ecommerce).not.toHaveProperty('coupon');
    expect(withPromoFieldsAbsent.ecommerce?.value).toBe(334);
    expect(withPromoFieldsAbsent.checkout_total).toBe(352);
  });

  it('promo: coupon + discountMinor apply to purchase ecommerce.value, coupon rides shipping/transaction_id', () => {
    const items = [product('k01'), product('v01')];
    const event = buildPurchaseEvent(items, {
      orderNo: 'ACC-1234',
      shippingCost: 18,
      shippingMethod: 'kurier',
      eventId: 'evt-purchase-promo',
      coupon: 'WELCOME10',
      discountMinor: 3400,
    });

    expect(event.ecommerce).toMatchObject({
      transaction_id: 'ACC-1234',
      value: 300,
      shipping: 18,
      coupon: 'WELCOME10',
    });
    expect(event.order_total).toBe(318);
    expect(event.meta).toMatchObject({ value: 318, order_id: 'ACC-1234' });
    const [k01Item, v01Item] = event.ecommerce!.items;
    expect(k01Item).toMatchObject({ price: 85.33, discount: 9.67 });
    expect(v01Item).toMatchObject({ price: 214.67, discount: 24.33 });
  });

  it('promo: with no coupon/discountMinor, purchase is byte-identical to the no-promo build (regression)', () => {
    const items = [product('k01'), product('v01')];
    const base = { orderNo: 'ACC-1234', shippingCost: 18, shippingMethod: 'kurier', eventId: 'evt-purchase' };
    const withPromoFieldsAbsent = buildPurchaseEvent(items, base);
    const legacy = buildPurchaseEvent(items, base);
    expect(withPromoFieldsAbsent).toEqual(legacy);
    expect(withPromoFieldsAbsent.ecommerce).not.toHaveProperty('coupon');
    expect(withPromoFieldsAbsent.ecommerce?.value).toBe(334);
    expect(withPromoFieldsAbsent.order_total).toBe(352);
  });

  describe('allocateItemDiscounts', () => {
    it('returns items unchanged (no discount field) when there is nothing to allocate', () => {
      const items = [{ price: 95 }, { price: 239 }];
      expect(allocateItemDiscounts(items, 0)).toBe(items);
      expect(allocateItemDiscounts(items, -100)).toBe(items);
    });

    it('allocates proportionally in minor units, giving the rounding remainder to the largest fractional share', () => {
      const items = [{ price: 95 }, { price: 239 }];
      const allocated = allocateItemDiscounts(items, 3400);
      expect(allocated).toEqual([
        { price: 85.33, discount: 9.67 },
        { price: 214.67, discount: 24.33 },
      ]);
      // Allocated discounts always sum to exactly the requested minor-unit total.
      expect(Math.round((allocated[0].discount! + allocated[1].discount!) * 100)).toBe(3400);
    });

    it('allocates the full discount to a single item', () => {
      expect(allocateItemDiscounts([{ price: 90 }], 3000)).toEqual([{ price: 60, discount: 30 }]);
    });
  });

  it('default purchase event_id is deterministic from orderNo for browser/server dedup', () => {
    const items = [product('k01'), product('v01')];
    const options = { orderNo: 'ACC-1234', shippingCost: 18, shippingMethod: 'kurier' };

    const event1 = buildPurchaseEvent(items, options);
    const event2 = buildPurchaseEvent(items, options);

    // Same orderNo must yield the SAME event_id: a server-side Meta CAPI / GA4
    // Measurement Protocol replay only knows the orderNo, so it must be able to
    // reconstruct this exact id to deduplicate against the browser event.
    expect(event1.event_id).toBe(event2.event_id);
    expect(event1.event_id).toBe('purchase-ACC-1234');

    // transaction_id stays the raw orderNo
    expect(event1.ecommerce?.transaction_id).toBe('ACC-1234');

    // meta.event_id (Meta's dedup key) mirrors event.event_id
    expect(event1.meta?.event_id).toBe(event1.event_id);
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
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '0.10.0');
    vi.stubEnv('NEXT_PUBLIC_GIT_SHA', '8ae90a5');
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

    expect(window.dataLayer).toEqual([
      { ...event, app_version: '0.10.0', app_git_sha: '8ae90a5' },
    ]);
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

  it('clears ecommerce before events that carry ecommerce payloads', () => {
    vi.stubGlobal('window', {
      dataLayer: [],
      document: { documentElement: { dataset: {} } },
      location: { hostname: 'example.com' },
    });

    pushDataLayer(buildAddToCartEvent(product('k01')));

    expect(window.dataLayer).toEqual([
      { ecommerce: null },
      expect.objectContaining({ event: 'add_to_cart' }),
    ]);
  });
});

describe('fine-art-print funnel builders', () => {
  const fap = { id: 'fap01', num: '01', variantLabel: '30×40 cm · no frame', price: 25 };

  it('view_item carries GA4 item + Meta ViewContent, item_id = design id', () => {
    const e = buildPrintViewItemEvent(fap, { currency: 'EUR', eventId: 'evt-vi' });
    expect(e).toMatchObject({
      event: 'view_item',
      event_id: 'evt-vi',
      ecommerce: {
        currency: 'EUR',
        value: 25,
        items: [{
          item_id: 'fap01',
          item_name: 'Print Nº 01',
          item_category: 'fine-art-prints',
          item_variant: '30×40 cm · no frame',
          price: 25,
          quantity: 1,
        }],
      },
      meta: { event_name: 'ViewContent', content_ids: ['fap01'], value: 25, event_id: 'evt-vi' },
    });
  });

  it('view_item_list indexes items and is GA4-only (no meta)', () => {
    const e = buildPrintViewItemListEvent(
      [fap, { id: 'fap02', num: '02', variantLabel: '30×40 cm · no frame', price: 25 }],
      { itemListId: 'fine-art-prints', itemListName: 'fine-art-prints', currency: 'EUR', eventId: 'evt-vil' },
    );
    expect(e.event).toBe('view_item_list');
    expect(e.meta).toBeUndefined();
    expect(e.ecommerce?.items).toMatchObject([
      { item_id: 'fap01', index: 0, item_list_id: 'fine-art-prints' },
      { item_id: 'fap02', index: 1, item_list_id: 'fine-art-prints' },
    ]);
  });

  it('select_item carries list context and is GA4-only', () => {
    const e = buildPrintSelectItemEvent(fap, { index: 3, itemListId: 'fine-art-prints', itemListName: 'fine-art-prints', currency: 'EUR' });
    expect(e.event).toBe('select_item');
    expect(e.meta).toBeUndefined();
    expect(e.ecommerce?.items[0]).toMatchObject({ item_id: 'fap01', index: 3, item_list_id: 'fine-art-prints' });
  });

  it('remove_from_cart is GA4-only, mirroring the ceramic remove', () => {
    const e = buildPrintRemoveFromCartEvent(fap, { currency: 'EUR' });
    expect(e.event).toBe('remove_from_cart');
    expect(e.meta).toBeUndefined();
    expect(e.ecommerce?.items[0].item_id).toBe('fap01');
  });

  it('add + view content_ids agree on the design id (feed-parity anchor)', () => {
    const add = buildPrintAddToCartEvent(fap, { currency: 'EUR' });
    const view = buildPrintViewItemEvent(fap, { currency: 'EUR' });
    expect(add.meta?.content_ids).toEqual(['fap01']);
    expect(view.meta?.content_ids).toEqual(['fap01']);
  });
});

describe('previously-untested builders', () => {
  it('remove_from_cart carries a single ceramic item and no meta', () => {
    const e = buildRemoveFromCartEvent(product('k01'), { currency: 'EUR' });
    expect(e.event).toBe('remove_from_cart');
    expect(e.ecommerce?.items).toHaveLength(1);
    expect(e.meta).toBeUndefined();
  });
  it('view_item wraps a ViewContent meta payload', () => {
    const e = buildViewItemEvent(product('k01'), { currency: 'EUR' });
    expect(e.event).toBe('view_item');
    expect(e.meta?.event_name).toBe('ViewContent');
  });
  it('view_item_list indexes items and carries list ids', () => {
    const e = buildViewItemListEvent([product('k01')], { itemListId: 'kubki', itemListName: 'Kubki' });
    expect(e.event).toBe('view_item_list');
    expect(e.ecommerce?.items[0].item_list_id).toBe('kubki');
    expect(e.ecommerce?.items[0].index).toBe(0);
  });
  it('select_item builds a single-item ecommerce payload', () => {
    expect(buildSelectItemEvent(product('k01')).event).toBe('select_item');
  });
  it('print add_to_cart uses the design id + variant label', () => {
    const e = buildPrintAddToCartEvent(
      { id: 'fap01', num: '1', variantLabel: 'A3 · framed', price: 220 },
      { currency: 'EUR' },
    );
    expect(e.ecommerce?.items[0].item_id).toBe('fap01');
    expect(e.ecommerce?.items[0].item_variant).toBe('A3 · framed');
    expect(e.meta?.content_ids).toEqual(['fap01']);
  });
  it('analyticsItemForId drops a print token with no priceOverride', () => {
    // Real 6-part token format `print:<design>:<size>:<framed>:<mount>:<frameColour>`
    // (the plan's illustrative `a3:satin:oak` would fail decodePrintToken).
    expect(analyticsItemForId('print:fap005:50x70:true:false:black')).toBeNull();
    expect(analyticsItemForId('print:fap005:50x70:true:false:black', 220)?.item_id).toBe('fap005');
  });
  it('login / sign_up carry method + user_id and no ecommerce', () => {
    const l = buildLoginEvent('google', 'u-123');
    expect(l.event).toBe('login');
    expect(l).toMatchObject({ method: 'google', user_id: 'u-123' });
    expect(l.ecommerce).toBeUndefined();
    expect(buildSignUpEvent('apple', 'u-9').event).toBe('sign_up');
  });
});
